import { Module } from '@nestjs/common';
import { PartnersService } from './partners.service';
import { ApiKeyGuard } from './api-key.guard';

@Module({
  providers: [PartnersService, ApiKeyGuard],
  exports: [PartnersService, ApiKeyGuard],
})
export class AuthModule {}