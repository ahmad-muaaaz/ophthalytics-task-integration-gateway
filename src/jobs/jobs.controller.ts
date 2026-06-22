import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { AnyFilesInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { ApiKeyGuard } from '../auth/api-key.guard';
import { AuthPartner } from '../auth/auth-partner.decorator';
import { CreateJobDto } from './dto/create-job.dto';
import { ParseMetadataPipe } from './pipes/parse-metadata.pipe';
import { JobsService } from './jobs.service';

const ALLOWED_MIMES = new Set(['image/jpeg', 'image/png', 'image/tiff', 'application/pdf']);
const MAX_FILE_BYTES = 25 * 1024 * 1024;   // 25 MB per file
const MAX_TOTAL_BYTES = 100 * 1024 * 1024; // 100 MB across all files
const MAX_IDEMPOTENCY_KEY_LENGTH = 256;

// Verify actual file content matches the declared MIME type by inspecting magic bytes.
// Trusting the client-supplied Content-Type alone lets an attacker label any binary as image/jpeg.
function verifyMagicBytes(buffer: Buffer, mimetype: string): boolean {
  if (!buffer || buffer.length < 4) return false;
  switch (mimetype) {
    case 'image/jpeg':
      return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
    case 'image/png':
      return buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47;
    case 'image/tiff':
      // little-endian: II* or big-endian: MM
      return (buffer[0] === 0x49 && buffer[1] === 0x49 && buffer[2] === 0x2a && buffer[3] === 0x00) ||
             (buffer[0] === 0x4d && buffer[1] === 0x4d && buffer[2] === 0x00 && buffer[3] === 0x2a);
    case 'application/pdf':
      return buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46; // %PDF
    default:
      return false;
  }
}

@Controller('jobs')
export class JobsController {
  constructor(private readonly jobsService: JobsService) {}

  @Post()
  @HttpCode(202)
  @UseGuards(ApiKeyGuard)
  @UseInterceptors(
    AnyFilesInterceptor({
      storage: memoryStorage(),
      limits: { fileSize: MAX_FILE_BYTES, files: 10 },
    }),
  )
  async create(
    @AuthPartner() partner: { id: string },
    @Headers('idempotency-key') idempotencyKey: string,
    @Body('metadata', ParseMetadataPipe) metadata: CreateJobDto & Record<string, unknown>,
    @UploadedFiles() files: Express.Multer.File[],
  ) {
    if (!idempotencyKey) {
      throw new BadRequestException({
        error: 'MISSING_IDEMPOTENCY_KEY',
        message: 'idempotency-key header is required',
      });
    }

    if (idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
      throw new BadRequestException({
        error: 'INVALID_IDEMPOTENCY_KEY',
        message: `idempotency-key must not exceed ${MAX_IDEMPOTENCY_KEY_LENGTH} characters`,
      });
    }

    if (!files?.length) {
      throw new BadRequestException({
        error: 'NO_FILES',
        message: 'At least one file is required',
      });
    }

    const invalidMime = files.find((f) => !ALLOWED_MIMES.has(f.mimetype));
    if (invalidMime) {
      throw new BadRequestException({
        error: 'INVALID_FILE_TYPE',
        message: `File type ${invalidMime.mimetype} is not allowed. Accepted: image/jpeg, image/png, image/tiff, application/pdf`,
      });
    }

    const spoofed = files.find((f) => !verifyMagicBytes(f.buffer, f.mimetype));
    if (spoofed) {
      throw new BadRequestException({
        error: 'INVALID_FILE_TYPE',
        message: `File "${spoofed.originalname}" content does not match its declared type`,
      });
    }

    const totalSize = files.reduce((sum, f) => sum + f.size, 0);
    if (totalSize > MAX_TOTAL_BYTES) {
      throw new BadRequestException({
        error: 'TOTAL_SIZE_EXCEEDED',
        message: 'Total upload size must not exceed 100MB',
      });
    }

    return this.jobsService.createJob(partner, idempotencyKey, metadata, files);
  }

  @Get(':id')
  @UseGuards(ApiKeyGuard)
  findOne(@AuthPartner() partner: { id: string }, @Param('id') id: string) {
    return this.jobsService.getJob(id, partner);
  }
}