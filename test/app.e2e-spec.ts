import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { AppModule } from '../src/app.module';

describe('Health (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    await app.init();
    await (app as NestFastifyApplication)
      .getHttpAdapter()
      .getInstance()
      .ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /health returns 200 with { status: "ok" }', async () => {
    const instance = (app as NestFastifyApplication)
      .getHttpAdapter()
      .getInstance();

    const response = await instance.inject({
      method: 'GET',
      url: '/health',
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ status: 'ok' });
  });

  it('unknown routes return 404 (GlobalExceptionFilter shape)', async () => {
    const instance = (app as NestFastifyApplication)
      .getHttpAdapter()
      .getInstance();

    const response = await instance.inject({
      method: 'GET',
      url: '/api/v1/nonexistent',
    });

    expect(response.statusCode).toBe(404);
  });
});
