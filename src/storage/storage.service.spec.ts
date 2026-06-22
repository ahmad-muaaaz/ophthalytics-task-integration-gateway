import { NotFoundException, UnauthorizedException } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { StorageService } from './storage.service';

describe('StorageService', () => {
  let service: StorageService;
  const testDir = join(process.cwd(), 'storage-test-tmp');

  beforeEach(async () => {
    process.env.STORAGE_SECRET = 'test-secret';
    process.env.STORAGE_PATH = testDir;
    await mkdir(testDir, { recursive: true });
    service = new StorageService();
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('round-trips sign and verify download tokens', () => {
    const token = service.signDownloadToken('job-abc');
    expect(service.verifyDownloadToken(token)).toEqual({ jobId: 'job-abc' });
  });

  it('rejects tokens with invalid signatures', () => {
    const token = service.signDownloadToken('job-abc');
    const tampered = token.slice(0, -1) + (token.endsWith('a') ? 'b' : 'a');

    expect(() => service.verifyDownloadToken(tampered)).toThrow(UnauthorizedException);
    try {
      service.verifyDownloadToken(tampered);
    } catch (e) {
      expect((e as UnauthorizedException).getResponse()).toMatchObject({ error: 'INVALID_TOKEN' });
    }
  });

  it('rejects expired tokens', () => {
    const payload = Buffer.from(JSON.stringify({ jobId: 'job-abc', exp: Date.now() - 1_000 })).toString(
      'base64url',
    );
    const sig = createHmac('sha256', 'test-secret').update(payload).digest('base64url');
    const expiredToken = `${payload}.${sig}`;

    expect(() => service.verifyDownloadToken(expiredToken)).toThrow(UnauthorizedException);
    try {
      service.verifyDownloadToken(expiredToken);
    } catch (e) {
      expect((e as UnauthorizedException).getResponse()).toMatchObject({ error: 'EXPIRED_TOKEN' });
    }
  });

  it('blocks path traversal when opening reports', async () => {
    await expect(service.openReport('../../etc/passwd')).rejects.toThrow(NotFoundException);
  });

  it('opens an existing report file', async () => {
    const relPath = 'partner-1/report.pdf';
    const absPath = join(testDir, relPath);
    await mkdir(join(testDir, 'partner-1'), { recursive: true });
    await writeFile(absPath, '%PDF-1.4');

    const opened = await service.openReport(relPath);
    expect(opened.size).toBeGreaterThan(0);
    opened.stream.destroy();
  });

  it('builds a download URL with encoded token', () => {
    process.env.APP_BASE_URL = 'http://localhost:3000';
    const url = service.buildDownloadUrl('abc.def');
    expect(url).toBe('http://localhost:3000/v1/reports/download?token=abc.def');
  });

  it('buildDownloadLinksForCompletedJob returns links only for completed jobs with reports', () => {
    process.env.APP_BASE_URL = 'http://localhost:3000';

    const links = service.buildDownloadLinksForCompletedJob('job-1', 'COMPLETED', 'p/report.pdf');
    expect(links?.downloadToken).toEqual(expect.any(String));
    expect(links?.downloadUrl).toContain('/v1/reports/download?token=');

    expect(service.buildDownloadLinksForCompletedJob('job-2', 'FAILED', null)).toBeNull();
    expect(service.buildDownloadLinksForCompletedJob('job-3', 'COMPLETED', null)).toBeNull();
  });
});