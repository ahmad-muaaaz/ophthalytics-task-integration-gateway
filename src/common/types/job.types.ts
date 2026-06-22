import { Attachment, Job } from '@prisma/client';

export type JobWithAttachments = Job & { attachments: Attachment[] };
