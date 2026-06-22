import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';

describe('Jobs API (e2e)', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('v1');
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('GET /v1/jobs/:id rejects requests without an API key', () => {
    return request(app.getHttpServer())
      .get('/v1/jobs/00000000-0000-0000-0000-000000000000')
      .expect(401)
      .expect((res) => {
        expect(res.body.error).toBe('MISSING_API_KEY');
      });
  });

  it('GET /v1/reports/download rejects requests without a token', () => {
    return request(app.getHttpServer())
      .get('/v1/reports/download')
      .expect(400)
      .expect((res) => {
        expect(res.body.error).toBe('MISSING_TOKEN');
      });
  });

  it('POST /v1/jobs/:id/webhooks/retry rejects requests without an API key', () => {
    return request(app.getHttpServer())
      .post('/v1/jobs/00000000-0000-0000-0000-000000000000/webhooks/retry')
      .expect(401)
      .expect((res) => {
        expect(res.body.error).toBe('MISSING_API_KEY');
      });
  });
});