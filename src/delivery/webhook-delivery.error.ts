export class WebhookDeliveryHttpError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number) {
    super(`Webhook delivery failed with HTTP ${statusCode}`);
    this.name = 'WebhookDeliveryHttpError';
    this.statusCode = statusCode;
  }
}