import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { AuthModule } from '../auth/auth.module';
import { DeliveryModule } from '../delivery/delivery.module';
import { StorageModule } from '../storage/storage.module';
import { JobsController } from './jobs.controller';
import { JobsService } from './jobs.service';
import { ParseMetadataPipe } from './pipes/parse-metadata.pipe';

@Module({
  imports: [
    AuthModule,
    StorageModule,
    DeliveryModule,
    BullModule.registerQueue({ name: 'processing' }),
  ],
  controllers: [JobsController],
  providers: [JobsService, ParseMetadataPipe],
})
export class JobsModule {}
