import { Injectable } from '@nestjs/common';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { JobWithAttachments } from '../common/types/job.types';

@Injectable()
export class ReportService {
  async generatePlaceholder(job: JobWithAttachments): Promise<Buffer> {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage();
    const metadata = job.metadata as Record<string, unknown>;

    const lines = [
      'Integration Gateway — Processing Report',
      `Job ID: ${job.id}`,
      `Partner ID: ${job.partnerId}`,
      `Patient ID: ${String(metadata.patientId ?? 'N/A')}`,
      `Study Type: ${String(metadata.studyType ?? 'N/A')}`,
      `Generated: ${new Date().toISOString()}`,
      `Attachments (${job.attachments.length}):`,
      ...job.attachments.map((a) => `  - ${a.filename} (${a.mimeType})`),
    ];

    let y = 750;
    for (const line of lines) {
      page.drawText(line, { x: 50, y, size: 12, font });
      y -= 20;
    }

    const bytes = await doc.save();
    return Buffer.from(bytes);
  }
}
