import { BadRequestException, NotFoundException, StreamableFile } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { StorageController } from './storage.controller';
import { StorageService } from './storage.service';

describe('StorageController', () => {
  let controller: StorageController;
  let storage: {
    verifyDownloadToken: jest.Mock;
    openReport: jest.Mock;
  };
  let prisma: { job: { findUnique: jest.Mock } };

  const mockResponse = {
    set: jest.fn(),
  };

  beforeEach(async () => {
    storage = {
      verifyDownloadToken: jest.fn().mockReturnValue({ jobId: 'job-1' }),
      openReport: jest.fn().mockResolvedValue({
        stream: { destroy: jest.fn() },
        size: 128,
      }),
    };
    prisma = {
      job: {
        findUnique: jest.fn().mockResolvedValue({
          status: 'COMPLETED',
          reportPath: 'partner-1/report.pdf',
        }),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [StorageController],
      providers: [
        { provide: StorageService, useValue: storage },
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    controller = module.get<StorageController>(StorageController);
  });

  it('rejects requests without a token', async () => {
    await expect(controller.download('', mockResponse as never)).rejects.toThrow(BadRequestException);
  });

  it('streams a completed report', async () => {
    const result = await controller.download('valid.token', mockResponse as never);

    expect(storage.verifyDownloadToken).toHaveBeenCalledWith('valid.token');
    expect(prisma.job.findUnique).toHaveBeenCalledWith({
      where: { id: 'job-1' },
      select: { status: true, reportPath: true },
    });
    expect(storage.openReport).toHaveBeenCalledWith('partner-1/report.pdf');
    expect(mockResponse.set).toHaveBeenCalledWith(
      expect.objectContaining({
        'Content-Type': 'application/pdf',
        'Content-Disposition': 'attachment; filename="report-job-1.pdf"',
      }),
    );
    expect(result).toBeInstanceOf(StreamableFile);
  });

  it('returns not found when the job has no report', async () => {
    prisma.job.findUnique.mockResolvedValue({ status: 'FAILED', reportPath: null });

    await expect(controller.download('valid.token', mockResponse as never)).rejects.toThrow(
      NotFoundException,
    );
  });
});