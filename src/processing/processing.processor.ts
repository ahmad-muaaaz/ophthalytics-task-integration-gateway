import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { ProcessingService } from './processing.service';

@Processor('processing')
export class ProcessingProcessor extends WorkerHost {
  private readonly logger = new Logger(ProcessingProcessor.name);

  constructor(private readonly processingService: ProcessingService) {
    super();
  }

  async process(job: Job<{ dbJobId: string }>): Promise<void> {
    if (job.name !== 'process-job') {
      throw new Error(`Unknown processing job name: ${job.name}`);
    }

    this.logger.log(`Processing job ${job.data.dbJobId} (attempt ${job.attemptsMade + 1})`);
    await this.processingService.processJob(job.data.dbJobId);
  }
}