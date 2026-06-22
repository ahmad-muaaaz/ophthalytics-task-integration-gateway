import { Test, TestingModule } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import {
  WebhookDeliveryHttpError,
  WebhookDeliveryInProgressError,
  WebhookEnqueueError,
} from './webhook-delivery.error';
import { WebhookService } from './webhook.service';

describe('WebhookService', () => {
  let service: WebhookService;
  let prisma: {
    webhookDelivery: {
      findUnique: jest.Mock;
      upsert: jest.Mock;
      update: jest.Mock;
    };
    job: {
      findUnique: jest.Mock;
    };
  };
  let storage: {
    buildDownloadLinksForCompletedJob: jest.Mock;
  };
  let deliveryQueue: { add: jest.Mock; remove: jest.Mock; getJob: jest.Mock };
  let fetchMock: jest.Mock;

  beforeEach(async () => {
    process.env.WEBHOOK_SECRET = 'test-webhook-secret';

    prisma = {
      webhookDelivery: {
        findUnique: jest.fn().mockResolvedValue(null),
        upsert: jest.fn().mockResolvedValue({}),
        update: jest.fn().mockResolvedValue({}),
      },
      job: {
        findUnique: jest.fn(),
      },
    };
    storage = {
      buildDownloadLinksForCompletedJob: jest.fn().mockReturnValue({
        downloadToken: 'signed-token',
        downloadUrl: 'http://localhost:3000/v1/reports/download?token=signed-token',
      }),
    };
    deliveryQueue = {
      add: jest.fn().mockResolvedValue({}),
      remove: jest.fn().mockResolvedValue(undefined),
      getJob: jest.fn().mockResolvedValue(null),
    };
    fetchMock = jest.fn();
    global.fetch = fetchMock;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WebhookService,
        { provide: PrismaService, useValue: prisma },
        { provide: StorageService, useValue: storage },
        { provide: getQueueToken('delivery'), useValue: deliveryQueue },
      ],
    }).compile();

    service = module.get<WebhookService>(WebhookService);
  });

  afterEach(() => {
    delete process.env.WEBHOOK_SECRET;
  });

  it('signs payload as sha256 hex over timestamp.body', () => {
    const body = '{"jobId":"j1"}';
    const sig = service.signPayload(body, '1710000000');
    expect(sig).toMatch(/^[a-f0-9]{64}$/);
    expect(service.signPayload(body, '1710000000')).toBe(sig);
  });

  it('scheduleDelivery upserts and enqueues deliver-webhook with deterministic jobId', async () => {
    await service.scheduleDelivery('job-1');

    expect(prisma.webhookDelivery.upsert).toHaveBeenCalledWith({
      where: { jobId: 'job-1' },
      create: { jobId: 'job-1', status: 'PENDING', attempts: 0 },
      update: {
        status: 'PENDING',
        responseCode: null,
        nextRetryAt: null,
      },
    });
    expect(deliveryQueue.add).toHaveBeenCalledWith(
      'deliver-webhook',
      { jobId: 'job-1' },
      {
        jobId: 'webhook-job-1',
        attempts: 5,
        backoff: { type: 'exponential', delay: 2000 },
      },
    );
  });

  it('scheduleDelivery marks FAILED when enqueue fails', async () => {
    deliveryQueue.add.mockRejectedValue(new Error('Redis unavailable'));

    await service.scheduleDelivery('job-1');

    expect(prisma.webhookDelivery.update).toHaveBeenCalledWith({
      where: { jobId: 'job-1' },
      data: expect.objectContaining({ status: 'FAILED', lastAttempt: expect.any(Date) }),
    });
  });

  it('scheduleDelivery skips when already delivered', async () => {
    prisma.webhookDelivery.findUnique.mockResolvedValue({ status: 'DELIVERED' });

    await service.scheduleDelivery('job-1');

    expect(prisma.webhookDelivery.upsert).not.toHaveBeenCalled();
    expect(deliveryQueue.add).not.toHaveBeenCalled();
  });

  it('deliver posts signed JSON with downloadUrl for completed jobs', async () => {
    prisma.job.findUnique.mockResolvedValue({
      id: 'job-1',
      status: 'COMPLETED',
      error: null,
      reportPath: 'partner-1/report.pdf',
      callbackUrl: 'https://partner.example/hook',
    });
    fetchMock.mockResolvedValue({ ok: true, status: 200 });

    await service.deliver('job-1');

    expect(storage.buildDownloadLinksForCompletedJob).toHaveBeenCalledWith(
      'job-1',
      'COMPLETED',
      'partner-1/report.pdf',
    );
    expect(fetchMock).toHaveBeenCalledWith(
      'https://partner.example/hook',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
          'X-Webhook-Timestamp': expect.any(String),
          'X-Webhook-Signature': expect.stringMatching(/^sha256=[a-f0-9]{64}$/),
        }),
      }),
    );

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body).toMatchObject({
      jobId: 'job-1',
      status: 'COMPLETED',
      error: null,
      downloadUrl: 'http://localhost:3000/v1/reports/download?token=signed-token',
    });
    expect(body.deliveredAt).toEqual(expect.any(String));

    expect(prisma.webhookDelivery.update).toHaveBeenCalledWith({
      where: { jobId: 'job-1' },
      data: expect.objectContaining({ status: 'DELIVERED', responseCode: 200 }),
    });
  });

  it('deliver omits downloadUrl for failed jobs', async () => {
    storage.buildDownloadLinksForCompletedJob.mockReturnValue(null);
    prisma.job.findUnique.mockResolvedValue({
      id: 'job-2',
      status: 'FAILED',
      error: 'Simulated processing failure',
      reportPath: null,
      callbackUrl: 'https://partner.example/hook',
    });
    fetchMock.mockResolvedValue({ ok: true, status: 204 });

    await service.deliver('job-2');

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.downloadUrl).toBeNull();
    expect(body.error).toBe('Simulated processing failure');
    expect(storage.buildDownloadLinksForCompletedJob).toHaveBeenCalledWith('job-2', 'FAILED', null);
  });

  it('deliver throws WebhookDeliveryHttpError on non-2xx responses', async () => {
    storage.buildDownloadLinksForCompletedJob.mockReturnValue(null);
    prisma.job.findUnique.mockResolvedValue({
      id: 'job-3',
      status: 'FAILED',
      error: 'err',
      reportPath: null,
      callbackUrl: 'https://partner.example/hook',
    });
    fetchMock.mockResolvedValue({ ok: false, status: 503 });

    await expect(service.deliver('job-3')).rejects.toBeInstanceOf(WebhookDeliveryHttpError);

    expect(prisma.webhookDelivery.update).toHaveBeenCalledWith({
      where: { jobId: 'job-3' },
      data: expect.objectContaining({ attempts: { increment: 1 }, responseCode: 503 }),
    });
  });

  it('markDeliveryFailed sets status to FAILED', async () => {
    await service.markDeliveryFailed('job-4');

    expect(prisma.webhookDelivery.update).toHaveBeenCalledWith({
      where: { jobId: 'job-4' },
      data: expect.objectContaining({ status: 'FAILED', lastAttempt: expect.any(Date) }),
    });
  });

  it('retryDelivery resets FAILED delivery, removes queue job, and re-enqueues', async () => {
    prisma.webhookDelivery.findUnique.mockResolvedValue({ status: 'FAILED', attempts: 3 });

    const result = await service.retryDelivery('job-5');

    expect(deliveryQueue.remove).toHaveBeenCalledWith('webhook-job-5');
    expect(prisma.webhookDelivery.upsert).toHaveBeenCalledWith({
      where: { jobId: 'job-5' },
      create: { jobId: 'job-5', status: 'PENDING', attempts: 0 },
      update: {
        status: 'PENDING',
        responseCode: null,
        nextRetryAt: null,
      },
    });
    expect(deliveryQueue.add).toHaveBeenCalledWith(
      'deliver-webhook',
      { jobId: 'job-5' },
      {
        jobId: 'webhook-job-5',
        attempts: 5,
        backoff: { type: 'exponential', delay: 2000 },
      },
    );
    expect(result).toEqual({ status: 'PENDING', attempts: 3 });
  });

  it('retryDelivery re-enqueues even when previously DELIVERED', async () => {
    prisma.webhookDelivery.findUnique.mockResolvedValue({ status: 'DELIVERED' });

    await service.retryDelivery('job-6');

    expect(deliveryQueue.remove).toHaveBeenCalledWith('webhook-job-6');
    expect(deliveryQueue.add).toHaveBeenCalled();
  });

  it('retryDelivery throws when delivery is in progress', async () => {
    prisma.webhookDelivery.findUnique.mockResolvedValue({ status: 'PENDING' });
    deliveryQueue.getJob.mockResolvedValue({
      getState: jest.fn().mockResolvedValue('active'),
    });

    await expect(service.retryDelivery('job-7')).rejects.toBeInstanceOf(
      WebhookDeliveryInProgressError,
    );
    expect(deliveryQueue.add).not.toHaveBeenCalled();
  });

  it('retryDelivery marks FAILED and rethrows WebhookEnqueueError when enqueue fails', async () => {
    prisma.webhookDelivery.findUnique.mockResolvedValue({ status: 'FAILED', attempts: 2 });
    deliveryQueue.add.mockRejectedValue(new Error('Redis unavailable'));

    await expect(service.retryDelivery('job-8')).rejects.toBeInstanceOf(WebhookEnqueueError);

    expect(prisma.webhookDelivery.update).toHaveBeenCalledWith({
      where: { jobId: 'job-8' },
      data: expect.objectContaining({ status: 'FAILED', lastAttempt: expect.any(Date) }),
    });
  });

  it('retryDelivery throws when queue job is in progress regardless of delivery status', async () => {
    prisma.webhookDelivery.findUnique.mockResolvedValue({ attempts: 5 });
    deliveryQueue.getJob.mockResolvedValue({
      getState: jest.fn().mockResolvedValue('waiting'),
    });

    await expect(service.retryDelivery('job-9')).rejects.toBeInstanceOf(
      WebhookDeliveryInProgressError,
    );
    expect(deliveryQueue.add).not.toHaveBeenCalled();
  });

  it('retryDelivery throws when queue job is paused', async () => {
    prisma.webhookDelivery.findUnique.mockResolvedValue({ attempts: 1 });
    deliveryQueue.getJob.mockResolvedValue({
      getState: jest.fn().mockResolvedValue('paused'),
    });

    await expect(service.retryDelivery('job-10')).rejects.toBeInstanceOf(
      WebhookDeliveryInProgressError,
    );
    expect(deliveryQueue.add).not.toHaveBeenCalled();
  });
});