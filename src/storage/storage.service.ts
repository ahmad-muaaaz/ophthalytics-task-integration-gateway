import { Injectable } from '@nestjs/common';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { randomUUID, createHmac } from 'node:crypto';

@Injectable()
export class StorageService {
  private readonly baseDir = process.env.STORAGE_PATH ?? './storage-data';
  private readonly secret = process.env.STORAGE_SECRET ?? 'dev-secret';

  constructor() {
    if (!process.env.STORAGE_SECRET) {
      console.warn(
        '[StorageService] STORAGE_SECRET env var is not set — using insecure default. Set it before deploying.',
      );
    }
  }

  async save(buffer: Buffer, originalFilename: string, subdir: string): Promise<string> {
    const dir = join(this.baseDir, subdir);
    await mkdir(dir, { recursive: true });
    // basename() strips any directory components (e.g. ../../etc/passwd) from
    // the client-supplied name, preventing path traversal outside baseDir.
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
}
