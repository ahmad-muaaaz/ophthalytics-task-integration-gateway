## Integration Gateway

A partner-facing API gateway that receives diagnostic job submissions, processes them asynchronously, generates PDF reports, and delivers results back to the partner via signed webhooks.

Built with NestJS, PostgreSQL, Redis, and BullMQ.

---

## Setup

**1. Start Docker Desktop**

Open Docker Desktop and wait until it is fully running, then start the infrastructure:

```bash
docker compose up -d
```

This starts PostgreSQL on port 5432 and Redis on port 6379. Verify both are up:

```bash
docker compose ps
```

**2. Install dependencies**

```bash
npm install
```

**3. Configure environment**

Create a `.env` file in the project root:

```
DATABASE_URL="postgresql://gateway:gateway@localhost:5432/gateway?schema=public"
REDIS_URL="redis://localhost:6379"
STORAGE_SECRET="your-secret-here"
WEBHOOK_SECRET="your-webhook-secret-here"
STORAGE_PATH="./storage-data"
PROCESSING_FAILURE_RATE="0.1"
APP_BASE_URL="http://localhost:3000"
```

**4. Apply database migrations**

```bash
npx prisma migrate deploy
```

**5. Seed a test partner**

```bash
npx prisma studio
```

Open the Partner table, add a record, and set an `apiKey` value. Use this value in the `x-api-key` header when making requests.

**6. Start the API**

```bash
npm run start:dev
```

The API listens on `http://localhost:3000`.

---

## What is Built

**Infrastructure**
PostgreSQL and Redis run as Docker containers defined in `docker-compose.yml`. Data persists across restarts via a named Docker volume.

**Database schema**
Four models: Partner, Job, Attachment, and WebhookDelivery. Managed via Prisma with applied migrations.

**Partner authentication**
Every request requires an `x-api-key` header. The guard looks up the key in the Partner table. If found, the full Partner record is attached to the request. If not, the request is rejected with a 401 before the controller runs. The partner identity is used throughout — jobs are scoped to their partner, files are stored under their partner ID, and cross-partner access returns 404.

**Job submission — POST /v1/jobs**
Accepts multipart form data with a JSON metadata field and one or more file attachments. Validates metadata fields, file types, file sizes, and magic bytes. Handles idempotency via a client-supplied header. Creates the Job and Attachment records in a single database transaction, saves files to local storage, and enqueues the job for processing. Returns 202 with a job ID.

**Job polling — GET /v1/jobs/:id**
Returns the current status of a job scoped to the authenticated partner. When the job is completed and a report exists, the response includes a `downloadToken` and a ready-to-use `downloadUrl`.

**Secure report download — GET /v1/reports/download**
Serves the completed PDF for a job. Authenticated by a signed `token` query parameter only (no API key). Verifies the HMAC signature with a timing-safe comparison, checks the one-hour expiry, loads `reportPath` from the database, and streams the file. No permanent public URL is issued.

**Processing pipeline**
Jobs are enqueued to a BullMQ `processing` queue on submission. A worker picks up each job, atomically claims it (`PENDING` → `PROCESSING`), simulates 2–10 seconds of work, and then either completes or fails. Roughly 10% of jobs fail randomly (configurable via `PROCESSING_FAILURE_RATE`). On success, a minimal placeholder PDF is generated and saved to `reportPath`. The worker is idempotent — if a job is already claimed or finished, it is skipped. Infrastructure failures during processing are retried up to 3 times with exponential backoff.

**File storage**
Files are written to `./storage-data/{partnerId}/` on local disk. Filenames are prefixed with a timestamp and UUID to prevent collisions. The original filename is sanitised with `path.basename()` before use to prevent path traversal. Files are cleaned up if the database transaction fails.

**Signed download tokens**
Tokens are HMAC-SHA256 signed and encode the job ID and a one-hour expiry. The download endpoint verifies the signature and expiry before serving the file.

**Signed webhook delivery**
When a job reaches `COMPLETED` or `FAILED`, a `deliver-webhook` job is enqueued on the BullMQ `delivery` queue. The worker POSTs a signed JSON payload to the partner's `callbackUrl` from job metadata. Delivery state is tracked in `WebhookDelivery` (one row per job). Failed deliveries are retried up to 5 times with exponential backoff (2s base). After all retries are exhausted, the delivery is marked `FAILED`. Manual re-trigger is planned for Phase 9.

Webhook signing uses `WEBHOOK_SECRET` when set, otherwise falls back to `STORAGE_SECRET`.

**Webhook request**

| Header | Value |
|---|---|
| `Content-Type` | `application/json` |
| `X-Webhook-Timestamp` | Unix timestamp (seconds) |
| `X-Webhook-Signature` | `sha256=<hmac_hex>` over `{timestamp}.{raw_json_body}` |

**Webhook payload**

| Field | Description |
|---|---|
| `jobId` | Job UUID |
| `status` | `COMPLETED` or `FAILED` |
| `error` | Error message when failed, otherwise `null` |
| `downloadUrl` | Signed download URL when completed, otherwise `null` |
| `deliveredAt` | ISO-8601 timestamp of the delivery attempt |

**Not yet built**
Developer Console frontend (Phase 9) and manual webhook retry endpoint.

---

## API Reference

### POST /v1/jobs

**Headers**

| Header | Required | Description |
|---|---|---|
| `x-api-key` | Yes | Partner API key |
| `idempotency-key` | Yes | Client-generated unique key, max 256 characters |

**Body — multipart/form-data**

| Field | Type | Description |
|---|---|---|
| `metadata` | Text | JSON string. Required fields: `patientId`, `studyType`, `callbackUrl`. Additional fields are accepted. |
| `file` | File | One or more files. Accepted: `image/jpeg`, `image/png`, `image/tiff`, `application/pdf`. Max 25MB per file, 100MB total. |

**Error codes**

| Code | HTTP | Cause |
|---|---|---|
| `MISSING_API_KEY` | 401 | No `x-api-key` header |
| `INVALID_API_KEY` | 401 | Key not found |
| `MISSING_IDEMPOTENCY_KEY` | 400 | No `idempotency-key` header |
| `INVALID_IDEMPOTENCY_KEY` | 400 | Key exceeds 256 characters |
| `INVALID_METADATA` | 400 | Non-JSON or missing required fields |
| `NO_FILES` | 400 | No files attached |
| `INVALID_FILE_TYPE` | 400 | MIME type not allowed or file content does not match declared type |
| `TOTAL_SIZE_EXCEEDED` | 400 | Combined file size exceeds 100MB |
| `QUEUE_ERROR` | 500 | Processing queue unavailable |

---

### GET /v1/jobs/:id

**Headers**

| Header | Required |
|---|---|
| `x-api-key` | Yes |

**Error codes**

| Code | HTTP | Cause |
|---|---|---|
| `MISSING_API_KEY` | 401 | No `x-api-key` header |
| `INVALID_API_KEY` | 401 | Key not found |
| `JOB_NOT_FOUND` | 404 | Job does not exist or belongs to a different partner |

**Response fields (when completed)**

| Field | Description |
|---|---|
| `downloadToken` | Signed, expiring token for the download endpoint |
| `downloadUrl` | Full URL: `{APP_BASE_URL}/v1/reports/download?token=...` |

---

### GET /v1/reports/download

**Query params**

| Param | Required | Description |
|---|---|---|
| `token` | Yes | `downloadToken` from a completed job |

**Auth:** token only — no `x-api-key` header required.

**Success:** `200` with `Content-Type: application/pdf`.

**Error codes**

| Code | HTTP | Cause |
|---|---|---|
| `MISSING_TOKEN` | 400 | No `token` query parameter |
| `INVALID_TOKEN` | 401 | Malformed token or invalid signature |
| `EXPIRED_TOKEN` | 401 | Token past its expiry timestamp |
| `REPORT_NOT_FOUND` | 404 | Job missing, not completed, or no report on record |
| `REPORT_UNAVAILABLE` | 404 | Report path exists in DB but file is missing on disk |

---

## Idempotency Design

Every `POST /v1/jobs` request requires an `idempotency-key` header. The key is scoped per partner — two different partners can use the same key without conflict.

**Normal flow:** before creating anything, the service queries the database for an existing job matching `(partnerId, idempotencyKey)`. If found, the existing job is returned immediately with no side effects.

**Race condition:** two requests with the same key can arrive simultaneously and both pass the pre-check because neither has committed yet. Both attempt to insert. The database unique constraint `@@unique([partnerId, idempotencyKey])` causes the second insert to fail with a Prisma `P2002` error. The losing request catches this, fetches the winning record, and returns it. Both callers receive the same response.

Any files the losing request already wrote to storage are deleted before returning.

---

## File Validation

File type is validated in two layers:

**Layer 1 — MIME type:** the declared `Content-Type` of the multipart part is checked against the allowed list (`image/jpeg`, `image/png`, `image/tiff`, `application/pdf`).

**Layer 2 — Magic bytes:** the first 4 bytes of the file buffer are checked against the known signatures for each type. A file labelled `image/jpeg` that does not start with `FF D8 FF` is rejected. This prevents a client from bypassing the check by falsifying the Content-Type header.

---

## Secure Download

Completed reports are served via a time-limited signed URL. The token is HMAC-SHA256 signed using `STORAGE_SECRET` and encodes the job ID with a one-hour expiry timestamp. `GET /v1/reports/download` verifies the signature using a timing-safe comparison, checks expiry, confirms the job is `COMPLETED` with a `reportPath`, and streams the PDF from local storage. Partners receive both `downloadToken` and `downloadUrl` when polling a completed job. No permanent public URL is issued.
