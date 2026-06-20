import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';

@Injectable()
export class AppService implements OnApplicationBootstrap {
  private readonly logger = new Logger('Redis');

  constructor(@InjectQueue('processing') private readonly queue: Queue) {}

  async onApplicationBootstrap() {
    const client = await this.queue.client;
    this.logger.verbose(`Redis connected — status: ${client.status}`);
  }
}
