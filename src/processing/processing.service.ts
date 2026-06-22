import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { JobWithAttachments } from '../common/types/job.types';
import type { ProcessingRuntime } from './processing.runtime';
import { defaultProcessingRuntime, PROCESSING_RUNTIME } from './processing.runtime';
import { WebhookService } from '../delivery/webhook.service';
import { ReportService } from '../reports/report.service';

const MIN_DELAY_MS = 2_000;
const MAX_DELAY_MS = 10_000;
const DEFAULT_FAILURE_RATE = 0.1;

@Injectable()
export class ProcessingService {
  private readonly logger = new Logger(ProcessingService.name);
  private readonly failureRate: number;
  private readonly runtime: ProcessingRuntime;

  constructor(
    private readonly prisma: PrismaService,
    private readonly reportService: ReportService,
    private readonly storage: StorageService,
    private readonly webhookService: WebhookService,
    @Inject(PROCESSING_RUNTIME) runtime: ProcessingRuntime = defaultProcessingRuntime,
  ) {
    const raw = process.env.PROCESSING_FAILURE_RATE;
    const parsed = raw !== undefined && raw !== '' ? parseFloat(raw) : NaN;
    if (Number.isFinite(parsed)) {
      this.failureRate = parsed;
    } else {
      if (raw !== undefined && raw !== '') {
        this.logger.warn(
          `Invalid PROCESSING_FAILURE_RATE "${raw}" — using default ${DEFAULT_FAILURE_RATE}`,
        );
      }
      this.failureRate = DEFAULT_FAILURE_RATE;
    }
    this.runtime = runtime;
  }

  async processJob(dbJobId: string): Promise<void> {
    const job = await this.claimJob(dbJobId);
    if (!job) return;

    const delayMs =
      MIN_DELAY_MS + Math.floor(this.runtime.random() * (MAX_DELAY_MS - MIN_DELAY_MS + 1));
    await this.runtime.sleep(delayMs);

    if (this.runtime.random() < this.failureRate) {
      await this.markSimulatedFailure(dbJobId);
      return;
    }

    let reportPath: string | undefined;
    try {
      const pdfBuffer = await this.reportService.generatePlaceholder(job);
      reportPath = await this.storage.save(pdfBuffer, 'report.pdf', job.partnerId);
      await this.prisma.job.update({
        where: { id: job.id },
        data: { status: 'COMPLETED', reportPath, error: null },
      });
      this.logger.log(`Job ${job.id} completed — report at ${reportPath}`);
      await this.scheduleWebhook(job.id);
    } catch (err) {
      if (reportPath) {
        await this.storage.delete(reportPath);
      }
      await this.releaseClaim(dbJobId);
      throw err;
    }
  }

  private async markSimulatedFailure(dbJobId: string): Promise<void> {
    this.logger.warn(`Job ${dbJobId} simulated failure`);
    await this.prisma.job.update({
      where: { id: dbJobId },
      data: { status: 'FAILED', error: 'Simulated processing failure' },
    });
    await this.scheduleWebhook(dbJobId);
  }

  private async scheduleWebhook(jobId: string): Promise<void> {
    try {
      await this.webhookService.scheduleDelivery(jobId);
    } catch (err) {
      this.logger.error(`Failed to schedule webhook for job ${jobId}`, err);
    }
  }

  private async claimJob(dbJobId: string): Promise<JobWithAttachments | null> {
    try {
      const job = await this.prisma.job.update({
        where: { id: dbJobId, status: 'PENDING' },
        data: { status: 'PROCESSING' },
        include: { attachments: true },
      });
      this.logger.log(`Job ${dbJobId} claimed — simulating processing`);
      return job;
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
        this.logger.log(`Job ${dbJobId} already claimed or finished — skipping`);
        return null;
      }
      throw err;
    }
  }

  private async releaseClaim(dbJobId: string): Promise<void> {
    await this.prisma.job.updateMany({
      where: { id: dbJobId, status: 'PROCESSING' },
      data: { status: 'PENDING' },
    });
  }
}