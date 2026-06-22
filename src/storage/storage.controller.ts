import {
  BadRequestException,
  Controller,
  Get,
  NotFoundException,
  Query,
  Res,
  StreamableFile,
} from '@nestjs/common';
import type { Response } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from './storage.service';

@Controller('reports')
export class StorageController {
  constructor(
    private readonly storage: StorageService,
    private readonly prisma: PrismaService,
  ) {}

  @Get('download')
  async download(
    @Query('token') token: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    if (!token) {
      throw new BadRequestException({
        error: 'MISSING_TOKEN',
        message: 'token query parameter is required',
      });
    }

    const { jobId } = this.storage.verifyDownloadToken(token);

    const job = await this.prisma.job.findUnique({
      where: { id: jobId },
      select: { status: true, reportPath: true },
    });

    if (!job || job.status !== 'COMPLETED' || !job.reportPath) {
      throw new NotFoundException({
        error: 'REPORT_NOT_FOUND',
        message: 'Report not found',
      });
    }

    const { stream, size } = await this.storage.openReport(job.reportPath);

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="report-${jobId}.pdf"`,
      'Content-Length': String(size),
    });

    return new StreamableFile(stream);
  }
}