import { Injectable, Logger, NotFoundException, UnauthorizedException } from '@nestjs/common';
import type { JobStatus } from '@prisma/client';
import { createReadStream } from 'node:fs';
import { mkdir, stat, unlink, writeFile } from 'node:fs/promises';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { join, basename, resolve, sep } from 'node:path';
import type { ReadStream } from 'node:fs';

type DownloadPayload = {
  jobId: string;
  exp: number;
};

@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  private readonly baseDir = process.env.STORAGE_PATH ?? './storage-data';
  private readonly secret = process.env.STORAGE_SECRET ?? 'dev-secret';

  constructor() {
    if (!process.env.STORAGE_SECRET) {
      this.logger.warn(
        'STORAGE_SECRET env var is not set — using insecure default. Set it before deploying.',
      );
    }
  }

  async save(buffer: Buffer, originalFilename: string, subdir: string): Promise<string> {
    const dir = join(this.baseDir, subdir);
    await mkdir(dir, { recursive: true });
    const safeFilename = basename(originalFilename);
    const generatedFilename = `${Date.now()}-${randomUUID()}-${safeFilename}`;
    await writeFile(join(dir, generatedFilename), buffer);
    return `${subdir}/${generatedFilename}`;
  }

  async delete(storagePath: string): Promise<void> {
    await unlink(join(this.baseDir, storagePath)).catch(() => {
      // best-effort; file may already be gone
    });
  }

  signDownloadToken(jobId: string): string {
    const payload = Buffer.from(
      JSON.stringify({ jobId, exp: Date.now() + 3_600_000 }),
    ).toString('base64url');
    const sig = createHmac('sha256', this.secret).update(payload).digest('base64url');
    return `${payload}.${sig}`;
  }

  verifyDownloadToken(token: string): { jobId: string } {
    const parts = token.split('.');
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      throw new UnauthorizedException({
        error: 'INVALID_TOKEN',
        message: 'Download token is malformed',
      });
    }

    const [payload, sig] = parts;
    const expectedSig = createHmac('sha256', this.secret).update(payload).digest('base64url');
    const sigBuf = Buffer.from(sig);
    const expectedBuf = Buffer.from(expectedSig);

    if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) {
      throw new UnauthorizedException({
        error: 'INVALID_TOKEN',
        message: 'Download token signature is invalid',
      });
    }

    let parsed: DownloadPayload;
    try {
      parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as DownloadPayload;
    } catch {
      throw new UnauthorizedException({
        error: 'INVALID_TOKEN',
        message: 'Download token payload is invalid',
      });
    }

    if (typeof parsed.jobId !== 'string' || !parsed.jobId || typeof parsed.exp !== 'number') {
      throw new UnauthorizedException({
        error: 'INVALID_TOKEN',
        message: 'Download token payload is invalid',
      });
    }

    if (Date.now() > parsed.exp) {
      throw new UnauthorizedException({
        error: 'EXPIRED_TOKEN',
        message: 'Download token has expired',
      });
    }

    return { jobId: parsed.jobId };
  }

  buildDownloadUrl(token: string): string {
    const base = (process.env.APP_BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '');
    return `${base}/v1/reports/download?token=${encodeURIComponent(token)}`;
  }

  buildDownloadLinksForCompletedJob(
    jobId: string,
    status: JobStatus,
    reportPath: string | null,
  ): { downloadToken: string; downloadUrl: string } | null {
    if (status !== 'COMPLETED' || !reportPath) {
      return null;
    }
    const downloadToken = this.signDownloadToken(jobId);
    return { downloadToken, downloadUrl: this.buildDownloadUrl(downloadToken) };
  }

  async openReport(storagePath: string): Promise<{ stream: ReadStream; size: number }> {
    const absolutePath = this.resolveSafePath(storagePath);

    let fileStat;
    try {
      fileStat = await stat(absolutePath);
    } catch {
      throw new NotFoundException({
        error: 'REPORT_UNAVAILABLE',
        message: 'Report file is not available',
      });
    }

    return { stream: createReadStream(absolutePath), size: fileStat.size };
  }

  private resolveSafePath(storagePath: string): string {
    const base = resolve(this.baseDir);
    const target = resolve(base, storagePath);
    if (target !== base && !target.startsWith(base + sep)) {
      throw new NotFoundException({
        error: 'REPORT_UNAVAILABLE',
        message: 'Report file is not available',
      });
    }
    return target;
  }
}