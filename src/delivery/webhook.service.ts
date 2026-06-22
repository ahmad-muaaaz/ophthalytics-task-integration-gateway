import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { DeliveryStatus, JobStatus } from '@prisma/client';
import { Queue } from 'bullmq';
import { createHmac } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import {
  WebhookDeliveryHttpError,
  WebhookDeliveryInProgressError,
  WebhookEnqueueError,
} from './webhook-delivery.error';

export type WebhookPayload = {
  jobId: string;
  status: JobStatus;
  error: string | null;
  downloadUrl: string | null;
  deliveredAt: string;
};

const DELIVERY_ATTEMPTS = 5;
const BACKOFF_MS = 2_000;
const REQUEST_TIMEOUT_MS = 10_000;
const TERMINAL_QUEUE_STATES = new Set(['completed', 'failed']);

@Injectable()
export class WebhookService {
  private readonly logger = new Logger(WebhookService.name);
  private readonly secret: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    @InjectQueue('delivery') private readonly deliveryQueue: Queue,
  ) {
    this.secret = process.env.WEBHOOK_SECRET ?? process.env.STORAGE_SECRET ?? 'dev-secret';
    if (!process.env.WEBHOOK_SECRET && !process.env.STORAGE_SECRET) {
      this.logger.warn(
        'WEBHOOK_SECRET and STORAGE_SECRET unset — using insecure dev default for webhook signing',
      );
    }
  }

  async scheduleDelivery(jobId: string): Promise<void> {
    const existing = await this.prisma.webhookDelivery.findUnique({
      where: { jobId },
      select: { status: true },
    });
    if (existing?.status === 'DELIVERED') {
      this.logger.debug(`Webhook for job ${jobId} already delivered — skipping`);
      return;
    }

    await this.resetDeliveryAndEnqueue(jobId, { rethrow: false });
  }

  async retryDelivery(jobId: string): Promise<{ status: DeliveryStatus; attempts: number }> {
    const delivery = await this.prisma.webhookDelivery.findUnique({
      where: { jobId },
      select: { attempts: true },
    });

    await this.assertDeliveryNotInProgress(jobId);
    await this.deliveryQueue.remove(this.queueJobId(jobId));

    await this.resetDeliveryAndEnqueue(jobId, { rethrow: true });

    return { status: 'PENDING', attempts: delivery?.attempts ?? 0 };
  }

  async deliver(jobId: string): Promise<void> {
    const job = await this.prisma.job.findUnique({
      where: { id: jobId },
      select: { id: true, status: true, error: true, reportPath: true, callbackUrl: true },
    });

    if (!job) {
      throw new Error(`Job ${jobId} not found for webhook delivery`);
    }

    if (job.status !== 'COMPLETED' && job.status !== 'FAILED') {
      throw new Error(`Job ${jobId} is not in a terminal state (${job.status})`);
    }

    const downloadUrl =
      this.storage.buildDownloadLinksForCompletedJob(job.id, job.status, job.reportPath)
        ?.downloadUrl ?? null;

    const payload: WebhookPayload = {
      jobId: job.id,
      status: job.status,
      error: job.error,
      downloadUrl,
      deliveredAt: new Date().toISOString(),
    };

    const body = JSON.stringify(payload);
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = this.signPayload(body, timestamp);

    const responseCode = await this.postWebhook(job.callbackUrl, body, timestamp, signature).catch(
      async (err) => {
        if (err instanceof WebhookDeliveryHttpError) {
          await this.recordAttempt(jobId, err.statusCode);
        } else {
          await this.recordAttempt(jobId);
        }
        throw err;
      },
    );

    await this.prisma.webhookDelivery.update({
      where: { jobId },
      data: {
        status: 'DELIVERED',
        responseCode,
        lastAttempt: new Date(),
        attempts: { increment: 1 },
        nextRetryAt: null,
      },
    });
    this.logger.log(`Webhook delivered for job ${jobId} (HTTP ${responseCode})`);
  }

  async markDeliveryFailed(jobId: string): Promise<void> {
    await this.prisma.webhookDelivery.update({
      where: { jobId },
      data: {
        status: 'FAILED',
        lastAttempt: new Date(),
      },
    });
    this.logger.warn(`Webhook delivery exhausted retries for job ${jobId}`);
  }

  signPayload(body: string, timestamp: string): string {
    return createHmac('sha256', this.secret).update(`${timestamp}.${body}`).digest('hex');
  }

  private async assertDeliveryNotInProgress(jobId: string): Promise<void> {
    const queueJob = await this.deliveryQueue.getJob(this.queueJobId(jobId));
    if (!queueJob) return;

    const state = await queueJob.getState();
    if (!TERMINAL_QUEUE_STATES.has(state)) {
      throw new WebhookDeliveryInProgressError(jobId);
    }
  }

  private async resetDeliveryRow(jobId: string): Promise<void> {
    await this.prisma.webhookDelivery.upsert({
      where: { jobId },
      create: { jobId, status: 'PENDING', attempts: 0 },
      update: {
        status: 'PENDING',
        responseCode: null,
        nextRetryAt: null,
      },
    });
  }

  private async resetDeliveryAndEnqueue(
    jobId: string,
    options: { rethrow: boolean },
  ): Promise<void> {
    await this.resetDeliveryRow(jobId);

    try {
      await this.enqueueDelivery(jobId);
      this.logger.log(`Webhook delivery scheduled for job ${jobId}`);
    } catch (err) {
      this.logger.error(`Failed to enqueue webhook for job ${jobId}`, err);
      await this.prisma.webhookDelivery.update({
        where: { jobId },
        data: { status: 'FAILED', lastAttempt: new Date() },
      });
      if (options.rethrow) throw err;
    }
  }

  private async postWebhook(
    callbackUrl: string,
    body: string,
    timestamp: string,
    signature: string,
  ): Promise<number> {
    const response = await fetch(callbackUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Timestamp': timestamp,
        'X-Webhook-Signature': `sha256=${signature}`,
      },
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new WebhookDeliveryHttpError(response.status);
    }

    return response.status;
  }

  private queueJobId(jobId: string): string {
    return `webhook-${jobId}`;
  }

  private async enqueueDelivery(jobId: string): Promise<void> {
    try {
      await this.deliveryQueue.add(
        'deliver-webhook',
        { jobId },
        {
          jobId: this.queueJobId(jobId),
          attempts: DELIVERY_ATTEMPTS,
          backoff: { type: 'exponential', delay: BACKOFF_MS },
        },
      );
    } catch (err) {
      throw new WebhookEnqueueError(jobId, err);
    }
  }

  private async recordAttempt(jobId: string, responseCode?: number): Promise<void> {
    await this.prisma.webhookDelivery.update({
      where: { jobId },
      data: {
        lastAttempt: new Date(),
        attempts: { increment: 1 },
        ...(responseCode !== undefined ? { responseCode } : {}),
      },
    });
  }
}