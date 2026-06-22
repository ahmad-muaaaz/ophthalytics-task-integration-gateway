import { Test, TestingModule } from '@nestjs/testing';
import { Job } from 'bullmq';
import { DeliveryProcessor } from './delivery.processor';
import { WebhookService } from './webhook.service';

describe('DeliveryProcessor', () => {
  let processor: DeliveryProcessor;
  let webhookService: { deliver: jest.Mock; markDeliveryFailed: jest.Mock };

  beforeEach(async () => {
    webhookService = {
      deliver: jest.fn().mockResolvedValue(undefined),
      markDeliveryFailed: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DeliveryProcessor,
        { provide: WebhookService, useValue: webhookService },
      ],
    }).compile();

    processor = module.get<DeliveryProcessor>(DeliveryProcessor);
  });

  it('delivers webhook for deliver-webhook jobs', async () => {
    const job = {
      name: 'deliver-webhook',
      data: { jobId: 'job-1' },
      attemptsMade: 0,
    } as Job<{ jobId: string }>;

    await processor.process(job);

    expect(webhookService.deliver).toHaveBeenCalledWith('job-1');
  });

  it('rejects unknown job names', async () => {
    const job = { name: 'other', data: { jobId: 'job-1' }, attemptsMade: 0 } as Job<{
      jobId: string;
    }>;

    await expect(processor.process(job)).rejects.toThrow('Unknown delivery job name: other');
  });

  it('marks delivery failed after final attempt', async () => {
    const job = {
      name: 'deliver-webhook',
      data: { jobId: 'job-1' },
      attemptsMade: 5,
      opts: { attempts: 5 },
    } as Job<{ jobId: string }>;

    await processor.onFailed(job);

    expect(webhookService.markDeliveryFailed).toHaveBeenCalledWith('job-1');
  });

  it('does not mark failed before retries are exhausted', async () => {
    const job = {
      name: 'deliver-webhook',
      data: { jobId: 'job-1' },
      attemptsMade: 2,
      opts: { attempts: 5 },
    } as Job<{ jobId: string }>;

    await processor.onFailed(job);

    expect(webhookService.markDeliveryFailed).not.toHaveBeenCalled();
  });
});