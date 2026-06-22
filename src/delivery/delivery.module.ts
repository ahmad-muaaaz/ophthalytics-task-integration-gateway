import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { PrismaModule } from '../prisma/prisma.module';
import { StorageModule } from '../storage/storage.module';
import { DeliveryProcessor } from './delivery.processor';
import { WebhookService } from './webhook.service';

@Module({
  imports: [
    BullModule.registerQueue({ name: 'delivery' }),
    PrismaModule,
    StorageModule,
  ],
  providers: [WebhookService, DeliveryProcessor],
  exports: [WebhookService],
})
export class DeliveryModule {}