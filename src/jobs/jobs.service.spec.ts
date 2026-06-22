import { ConflictException, NotFoundException } from '@nestjs/common';
import { getQueueToken } from '@nestjs/bullmq';
import { Test, TestingModule } from '@nestjs/testing';
import {
  WebhookDeliveryInProgressError,
  WebhookEnqueueError,
} from '../delivery/webhook-delivery.error';
import { WebhookService } from '../delivery/webhook.service';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { JobsService } from './jobs.service';

describe('JobsService', () => {
  let service: JobsService;
  let prisma: {
    job: {
      findUnique: jest.Mock;
      findUniqueOrThrow: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
    };
    $transaction: jest.Mock;
  };
  let storage: {
    save: jest.Mock;
    delete: jest.Mock;
    buildDownloadLinksForCompletedJob: jest.Mock;
  };
  let webhookService: { retryDelivery: jest.Mock };

  const partner = { id: 'partner-1' };

  beforeEach(async () => {
    prisma = {
      job: {
        findUnique: jest.fn(),
        findUniqueOrThrow: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
      $transaction: jest.fn(),
    };
    storage = {
      save: jest.fn(),
      delete: jest.fn(),
      buildDownloadLinksForCompletedJob: jest.fn().mockReturnValue(null),
    };
    webhookService = {
      retryDelivery: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        JobsService,
        { provide: PrismaService, useValue: prisma },
        { provide: StorageService, useValue: storage },
        { provide: WebhookService, useValue: webhookService },
        { provide: getQueueToken('processing'), useValue: { add: jest.fn() } },
      ],
    }).compile();

    service = module.get<JobsService>(JobsService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('getJob', () => {
    it('throws 404 when job does not exist', async () => {
      prisma.job.findUnique.mockResolvedValue(null);

      await expect(service.getJob('job-missing', partner)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('throws 404 when job belongs to another partner', async () => {
      prisma.job.findUnique.mockResolvedValue({
        id: 'job-1',
        partnerId: 'other-partner',
        status: 'COMPLETED',
        metadata: {},
        callbackUrl: 'https://example.com/hook',
        error: null,
        reportPath: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        attachments: [],
        deliveries: [],
      });

      await expect(service.getJob('job-1', partner)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('includes webhookDelivery when a delivery record exists', async () => {
      const lastAttempt = new Date('2026-06-22T12:00:00.000Z');
      prisma.job.findUnique.mockResolvedValue({
        id: 'job-1',
        partnerId: partner.id,
        status: 'COMPLETED',
        metadata: { patientId: 'P-1' },
        callbackUrl: 'https://example.com/hook',
        error: null,
        reportPath: 'partner-1/report.pdf',
        createdAt: new Date('2026-06-22T11:00:00.000Z'),
        updatedAt: new Date('2026-06-22T12:00:00.000Z'),
        attachments: [
          {
            id: 'att-1',
            filename: 'scan.jpg',
            mimeType: 'image/jpeg',
            sizeBytes: 1024,
          },
        ],
        deliveries: [
          {
            status: 'DELIVERED',
            attempts: 1,
            lastAttempt,
            responseCode: 200,
          },
        ],
      });
      storage.buildDownloadLinksForCompletedJob.mockReturnValue({
        downloadToken: 'token',
        downloadUrl: 'http://localhost:3000/v1/reports/download?token=token',
      });

      await expect(service.getJob('job-1', partner)).resolves.toEqual({
        jobId: 'job-1',
        status: 'COMPLETED',
        metadata: { patientId: 'P-1' },
        callbackUrl: 'https://example.com/hook',
        createdAt: new Date('2026-06-22T11:00:00.000Z'),
        updatedAt: new Date('2026-06-22T12:00:00.000Z'),
        attachments: [
          {
            id: 'att-1',
            filename: 'scan.jpg',
            mimeType: 'image/jpeg',
            sizeBytes: 1024,
          },
        ],
        webhookDelivery: {
          status: 'DELIVERED',
          attempts: 1,
          lastAttempt,
          responseCode: 200,
        },
        downloadToken: 'token',
        downloadUrl: 'http://localhost:3000/v1/reports/download?token=token',
      });
    });
  });

  describe('retryWebhook', () => {
    it('throws 404 when job belongs to another partner', async () => {
      prisma.job.findUnique.mockResolvedValue({
        id: 'job-1',
        status: 'COMPLETED',
        partnerId: 'other-partner',
      });

      await expect(service.retryWebhook('job-1', partner)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(webhookService.retryDelivery).not.toHaveBeenCalled();
    });

    it('throws 404 when job does not exist', async () => {
      prisma.job.findUnique.mockResolvedValue(null);

      await expect(service.retryWebhook('job-missing', partner)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('throws 409 when job is not terminal', async () => {
      prisma.job.findUnique.mockResolvedValue({
        id: 'job-1',
        status: 'PROCESSING',
        partnerId: partner.id,
      });

      await expect(service.retryWebhook('job-1', partner)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(webhookService.retryDelivery).not.toHaveBeenCalled();
    });

    it('throws 409 when delivery is already in progress', async () => {
      prisma.job.findUnique.mockResolvedValue({
        id: 'job-1',
        status: 'COMPLETED',
        partnerId: partner.id,
      });
      webhookService.retryDelivery.mockRejectedValue(
        new WebhookDeliveryInProgressError('job-1'),
      );

      await expect(service.retryWebhook('job-1', partner)).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('throws 500 QUEUE_ERROR only for enqueue failures', async () => {
      prisma.job.findUnique.mockResolvedValue({
        id: 'job-1',
        status: 'FAILED',
        partnerId: partner.id,
      });
      webhookService.retryDelivery.mockRejectedValue(new WebhookEnqueueError('job-1'));

      await expect(service.retryWebhook('job-1', partner)).rejects.toMatchObject({
        response: {
          error: 'QUEUE_ERROR',
          message: 'Failed to schedule webhook retry. Please try again.',
        },
      });
    });

    it('rethrows unexpected errors instead of mapping to QUEUE_ERROR', async () => {
      prisma.job.findUnique.mockResolvedValue({
        id: 'job-1',
        status: 'COMPLETED',
        partnerId: partner.id,
      });
      const unexpected = new Error('database connection lost');
      webhookService.retryDelivery.mockRejectedValue(unexpected);

      await expect(service.retryWebhook('job-1', partner)).rejects.toBe(unexpected);
    });

    it('returns 202 payload on success', async () => {
      prisma.job.findUnique.mockResolvedValue({
        id: 'job-1',
        status: 'COMPLETED',
        partnerId: partner.id,
      });
      webhookService.retryDelivery.mockResolvedValue({ status: 'PENDING', attempts: 3 });

      await expect(service.retryWebhook('job-1', partner)).resolves.toEqual({
        jobId: 'job-1',
        webhookDelivery: { status: 'PENDING', attempts: 3 },
      });
    });
  });
});