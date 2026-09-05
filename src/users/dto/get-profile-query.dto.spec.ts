import { Controller, Get, Query, ValidationPipe } from '@nestjs/common';
import { VALIDATION_PIPE_OPTIONS } from '../../common/validation-pipe-options';
import { Test } from '@nestjs/testing';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import type { FastifyInstance } from 'fastify';
import { GetProfileQueryDto } from './get-profile-query.dto';

/**
 * Pins the /users/me query-string contract (Story 3.9 added jobsScope).
 * The global ValidationPipe (mirroring main.ts) must reject an unknown
 * jobsScope with 422 — a typo'd value must never silently fall back to the
 * full-history default.
 */

@Controller()
class ProfileEchoController {
  @Get('me')
  me(@Query() query: GetProfileQueryDto): Record<string, unknown> {
    return {
      jobsScope: query.jobsScope ?? null,
      jobsCursor: query.jobsCursor ?? null,
    };
  }
}

describe('GetProfileQueryDto through the ValidationPipe (mirrors main.ts config)', () => {
  let app: NestFastifyApplication;
  let fastify: FastifyInstance;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ProfileEchoController],
    }).compile();
    app = moduleRef.createNestApplication(
      new FastifyAdapter({
        logger: false,
        routerOptions: { ignoreTrailingSlash: true },
      }),
    );
    app.useGlobalPipes(new ValidationPipe(VALIDATION_PIPE_OPTIONS));
    await app.init();
    fastify = app.getHttpAdapter().getInstance();
  });

  afterAll(async () => {
    await app.close();
  });

  const get = (url: string) => fastify.inject({ method: 'GET', url });

  it('accepts jobsScope=today', async () => {
    const res = await get('/me?jobsScope=today');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ jobsScope: 'today', jobsCursor: null });
  });

  it('accepts jobsScope=all', async () => {
    const res = await get('/me?jobsScope=all');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ jobsScope: 'all', jobsCursor: null });
  });

  it('leaves jobsScope undefined when omitted (default behaviour)', async () => {
    const res = await get('/me');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ jobsScope: null, jobsCursor: null });
  });

  it('rejects an unknown jobsScope value with 422', async () => {
    const res = await get('/me?jobsScope=next-week');
    expect(res.statusCode).toBe(422);
  });

  it('rejects an empty jobsScope value with 422', async () => {
    const res = await get('/me?jobsScope=');
    expect(res.statusCode).toBe(422);
  });

  it('trims a padded jobsScope value before validation', async () => {
    const res = await get('/me?jobsScope=%20today%20');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ jobsScope: 'today', jobsCursor: null });
  });

  it('rejects a jobsScope that trims to empty with 422', async () => {
    const res = await get('/me?jobsScope=%20%20');
    expect(res.statusCode).toBe(422);
  });
});
