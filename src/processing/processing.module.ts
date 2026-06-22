import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { DeliveryModule } from '../delivery/delivery.module';
import { StorageModule } from '../storage/storage.module';
import { ReportsModule } from '../reports/reports.module';
import { defaultProcessingRuntime, PROCESSING_RUNTIME } from './processing.runtime';
import { ProcessingProcessor } from './processing.processor';
import { ProcessingService } from './processing.service';

@Module({
  imports: [BullModule.registerQueue({ name: 'processing' }), StorageModule, DeliveryModule, ReportsModule],
  providers: [
    { provide: PROCESSING_RUNTIME, useValue: defaultProcessingRuntime },
    ProcessingService,
    ProcessingProcessor,
  ],
  exports: [ProcessingService],
})
export class ProcessingModule {}