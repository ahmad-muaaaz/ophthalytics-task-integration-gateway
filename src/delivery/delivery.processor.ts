import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { WebhookService } from './webhook.service';

@Processor('delivery')
export class DeliveryProcessor extends WorkerHost {
  private readonly logger = new Logger(DeliveryProcessor.name);

  constructor(private readonly webhookService: WebhookService) {
    super();
  }

  async process(job: Job<{ jobId: string }>): Promise<void> {
    if (job.name !== 'deliver-webhook') {
      throw new Error(`Unknown delivery job name: ${job.name}`);
    }

    this.logger.log(
      `Delivering webhook for job ${job.data.jobId} (attempt ${job.attemptsMade + 1})`,
    );
    await this.webhookService.deliver(job.data.jobId);
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job<{ jobId: string }> | undefined): Promise<void> {
    if (!job || job.name !== 'deliver-webhook') return;

    const maxAttempts = job.opts.attempts ?? 1;
    if (job.attemptsMade >= maxAttempts) {
      await this.webhookService.markDeliveryFailed(job.data.jobId);
    }
  }
}