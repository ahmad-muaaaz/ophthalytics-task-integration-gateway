import { Injectable, InternalServerErrorException, Logger, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { CreateJobDto } from './dto/create-job.dto';

@Injectable()
export class JobsService {
  private readonly logger = new Logger(JobsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    @InjectQueue('processing') private readonly processingQueue: Queue,
  ) {}

  async createJob(
    partner: { id: string },
    idempotencyKey: string,
    metadata: CreateJobDto & Record<string, unknown>,
    files: Express.Multer.File[],
  ) {
    const existing = await this.prisma.job.findUnique({
      where: {
        partnerId_idempotencyKey: { partnerId: partner.id, idempotencyKey },
      },
      select: { id: true, status: true },
    });
    if (existing) {
      this.logger.debug(`Idempotent hit for job ${existing.id}`);
      return { jobId: existing.id, status: existing.status };
    }

    const savedFiles = await Promise.all(
      files.map(async (file) => ({
        filename: file.originalname,
        mimeType: file.mimetype,
        sizeBytes: file.size,
        storagePath: await this.storage.save(file.buffer, file.originalname, partner.id),
      })),
    );

    let job: { id: string; status: string };
    try {
      job = await this.prisma.$transaction(async (tx) => {
        return tx.job.create({
          data: {
            partnerId: partner.id,
            idempotencyKey,
            metadata: metadata as Prisma.InputJsonValue,
            callbackUrl: metadata.callbackUrl,
            attachments: { create: savedFiles },
          },
          select: { id: true, status: true },
        });
      });
    } catch (e) {
      await Promise.allSettled(savedFiles.map((f) => this.storage.delete(f.storagePath)));

      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const raced = await this.prisma.job.findUniqueOrThrow({
          where: {
            partnerId_idempotencyKey: { partnerId: partner.id, idempotencyKey },
          },
          select: { id: true, status: true },
        });
        return { jobId: raced.id, status: raced.status };
      }
      throw e;
    }

    try {
      await this.processingQueue.add(
        'process-job',
        { dbJobId: job.id },
        { attempts: 3, backoff: { type: 'exponential', delay: 1000 } },
      );
      this.logger.log(`Job ${job.id} enqueued for processing`);
    } catch {
      await this.prisma.job.update({
        where: { id: job.id },
        data: { status: 'FAILED', error: 'Failed to enqueue job for processing' },
      });
      throw new InternalServerErrorException({
        error: 'QUEUE_ERROR',
        message: 'Failed to schedule job processing. Please retry.',
      });
    }

    return { jobId: job.id, status: job.status };
  }

  async getJob(jobId: string, partner: { id: string }) {
    const job = await this.prisma.job.findUnique({
      where: { id: jobId },
      include: { attachments: true },
    });

    if (!job || job.partnerId !== partner.id) {
      throw new NotFoundException({ error: 'JOB_NOT_FOUND', message: 'Job not found' });
    }

    const downloadLinks = this.storage.buildDownloadLinksForCompletedJob(
      job.id,
      job.status,
      job.reportPath,
    );

    return {
      jobId: job.id,
      status: job.status,
      metadata: job.metadata,
      callbackUrl: job.callbackUrl,
      ...(job.error ? { error: job.error } : {}),
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      attachments: job.attachments.map((a) => ({
        id: a.id,
        filename: a.filename,
        mimeType: a.mimeType,
        sizeBytes: a.sizeBytes,
      })),
      ...(downloadLinks ?? {}),
    };
  }
}