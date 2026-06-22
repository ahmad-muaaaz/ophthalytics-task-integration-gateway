import { Prisma } from '@prisma/client';
import { ProcessingService } from './processing.service';
import { PrismaService } from '../prisma/prisma.service';
import { ReportService } from '../reports/report.service';
import { StorageService } from '../storage/storage.service';
import { WebhookService } from '../delivery/webhook.service';
import { JobWithAttachments } from '../common/types/job.types';
import { ProcessingRuntime } from './processing.runtime';

describe('ProcessingService', () => {
  const baseJob: JobWithAttachments = {
    id: 'job-1',
    partnerId: 'partner-1',
    idempotencyKey: 'key-1',
    status: 'PENDING',
    metadata: { patientId: 'p1', studyType: 'OCT', callbackUrl: 'https://example.com/hook' },
    callbackUrl: 'https://example.com/hook',
    reportPath: null,
    error: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    attachments: [
      {
        id: 'att-1',
        jobId: 'job-1',
        filename: 'scan.jpg',
        mimeType: 'image/jpeg',
        sizeBytes: 100,
        storagePath: 'partner-1/scan.jpg',
        createdAt: new Date(),
      },
    ],
  };

  let prisma: {
    job: {
      update: jest.Mock;
      updateMany: jest.Mock;
    };
  };
  let reportService: { generatePlaceholder: jest.Mock };
  let storageService: { save: jest.Mock; delete: jest.Mock };
  let webhookService: { scheduleDelivery: jest.Mock };
  let runtime: ProcessingRuntime;

  const createService = () =>
    new ProcessingService(
      prisma as unknown as PrismaService,
      reportService as unknown as ReportService,
      storageService as unknown as StorageService,
      webhookService as unknown as WebhookService,
      runtime,
    );

  beforeEach(() => {
    prisma = {
      job: {
        update: jest.fn(),
        updateMany: jest.fn(),
      },
    };
    reportService = { generatePlaceholder: jest.fn().mockResolvedValue(Buffer.from('%PDF')) };
    storageService = {
      save: jest.fn().mockResolvedValue('partner-1/report.pdf'),
      delete: jest.fn().mockResolvedValue(undefined),
    };
    webhookService = { scheduleDelivery: jest.fn().mockResolvedValue(undefined) };
    runtime = {
      sleep: jest.fn().mockResolvedValue(undefined),
      random: jest.fn(),
    };
  });

  it('completes a pending job with a placeholder report', async () => {
    prisma.job.update
      .mockResolvedValueOnce(baseJob)
      .mockResolvedValueOnce({ ...baseJob, status: 'COMPLETED' });
    (runtime.random as jest.Mock).mockReturnValueOnce(0.5).mockReturnValueOnce(0.5);

    await createService().processJob('job-1');

    expect(prisma.job.update).toHaveBeenNthCalledWith(1, {
      where: { id: 'job-1', status: 'PENDING' },
      data: { status: 'PROCESSING' },
      include: { attachments: true },
    });
    expect(reportService.generatePlaceholder).toHaveBeenCalledWith(baseJob);
    expect(storageService.save).toHaveBeenCalled();
    expect(prisma.job.update).toHaveBeenNthCalledWith(2, {
      where: { id: 'job-1' },
      data: { status: 'COMPLETED', reportPath: 'partner-1/report.pdf', error: null },
    });
    expect(webhookService.scheduleDelivery).toHaveBeenCalledWith('job-1');
  });

  it('marks the job failed on simulated processing failure without releasing claim', async () => {
    prisma.job.update.mockResolvedValueOnce(baseJob).mockResolvedValueOnce({ ...baseJob, status: 'FAILED' });
    (runtime.random as jest.Mock).mockReturnValueOnce(0.5).mockReturnValueOnce(0);

    await createService().processJob('job-1');

    expect(prisma.job.update).toHaveBeenNthCalledWith(2, {
      where: { id: 'job-1' },
      data: { status: 'FAILED', error: 'Simulated processing failure' },
    });
    expect(reportService.generatePlaceholder).not.toHaveBeenCalled();
    expect(prisma.job.updateMany).not.toHaveBeenCalled();
    expect(storageService.delete).not.toHaveBeenCalled();
    expect(webhookService.scheduleDelivery).toHaveBeenCalledWith('job-1');
  });

  it('skips when the job is already claimed or finished', async () => {
    const notFound = new Prisma.PrismaClientKnownRequestError('Record not found', {
      code: 'P2025',
      clientVersion: 'test',
    });
    prisma.job.update.mockRejectedValueOnce(notFound);

    await createService().processJob('job-1');

    expect(runtime.sleep).not.toHaveBeenCalled();
    expect(prisma.job.update).toHaveBeenCalledTimes(1);
    expect(webhookService.scheduleDelivery).not.toHaveBeenCalled();
  });

  it('releases claim and deletes orphan report on infrastructure failure', async () => {
    prisma.job.update
      .mockResolvedValueOnce(baseJob)
      .mockRejectedValueOnce(new Error('DB unavailable'));
    (runtime.random as jest.Mock).mockReturnValueOnce(0.5).mockReturnValueOnce(0.5);

    await expect(createService().processJob('job-1')).rejects.toThrow('DB unavailable');

    expect(storageService.delete).toHaveBeenCalledWith('partner-1/report.pdf');
    expect(prisma.job.updateMany).toHaveBeenCalledWith({
      where: { id: 'job-1', status: 'PROCESSING' },
      data: { status: 'PENDING' },
    });
    expect(webhookService.scheduleDelivery).not.toHaveBeenCalled();
  });
});