import { ReportService } from './report.service';
import { JobWithAttachments } from '../common/types/job.types';

describe('ReportService', () => {
  let service: ReportService;

  const job: JobWithAttachments = {
    id: 'job-1',
    partnerId: 'partner-1',
    idempotencyKey: 'key-1',
    status: 'PROCESSING',
    metadata: { patientId: 'p1', studyType: 'OCT', callbackUrl: 'https://example.com/hook' },
    callbackUrl: 'https://example.com/hook',
    reportPath: null,
    error: null,
    createdAt: new Date('2026-06-22T12:00:00.000Z'),
    updatedAt: new Date('2026-06-22T12:00:00.000Z'),
    attachments: [
      {
        id: 'att-1',
        jobId: 'job-1',
        filename: 'scan.jpg',
        mimeType: 'image/jpeg',
        sizeBytes: 100,
        storagePath: 'partner-1/scan.jpg',
        createdAt: new Date(),
      },
    ],
  };

  beforeEach(() => {
    service = new ReportService();
  });

  it('generates a valid PDF buffer', async () => {
    const buffer = await service.generatePlaceholder(job);
    expect(buffer.subarray(0, 4).toString()).toBe('%PDF');
  });
});
