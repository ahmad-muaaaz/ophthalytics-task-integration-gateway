export class WebhookDeliveryHttpError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number) {
    super(`Webhook delivery failed with HTTP ${statusCode}`);
    this.name = 'WebhookDeliveryHttpError';
    this.statusCode = statusCode;
  }
}

export class WebhookDeliveryInProgressError extends Error {
  constructor(jobId: string) {
    super(`Webhook delivery for job ${jobId} is already in progress`);
    this.name = 'WebhookDeliveryInProgressError';
  }
}

export class WebhookEnqueueError extends Error {
  constructor(jobId: string, cause?: unknown) {
    super(`Failed to enqueue webhook delivery for job ${jobId}`);
    this.name = 'WebhookEnqueueError';
    this.cause = cause;
  }
}