import { Controller, Get, Query, Req, ValidationPipe } from '@nestjs/common';
import { VALIDATION_PIPE_OPTIONS } from '../../common/validation-pipe-options';
import { Test } from '@nestjs/testing';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { JobStatus } from '../enums/job-status.enum';
import { JobListScope } from '../enums/job-list-scope.enum';
import { ListJobsQueryDto } from './list-jobs-query.dto';

/**
 * Pins the query-string dialect this API speaks.
 *
 * Fastify's default parser reads repeatable keys in repeat style
 * (`?status=a&status=b` → string when repeated once, array when repeated 2+)
 * and does NOT understand bracket style (`?status[]=a`): the whole `status[]`
 * is a literal key, so `status` never appears and any filter sent that way is
 * silently ignored — no error, just wrong results. This is the assumption
 * `toArray` and `@IsArray` are built on. A parser swap that starts accepting
 * bracket style, or a DTO change that drops the normalization, reintroduces
 * the silent-ignore trap for clients emitting repeat style; these tests fail
 * loudly if either drifts.
 */

@Controller()
class EchoQueryController {
  @Get('echo')
  echo(@Req() req: FastifyRequest): Record<string, unknown> {
    return req.query as Record<string, unknown>;
  }
}

@Controller()
class ListJobsEchoController {
  @Get('jobs')
  jobs(@Query() query: ListJobsQueryDto): {
    status: JobStatus[] | null;
    scope: JobListScope | null;
  } {
    return { status: query.status ?? null, scope: query.scope ?? null };
  }
}

describe('query-string dialect ListJobsQueryDto assumes', () => {
  let app: NestFastifyApplication;
  let fastify: FastifyInstance;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [EchoQueryController, ListJobsEchoController],
    }).compile();
    app = moduleRef.createNestApplication(
      new FastifyAdapter({
        logger: false,
        routerOptions: { ignoreTrailingSlash: true },
      }),
    );
    // Mirrors main.ts's global ValidationPipe options — keep in sync until shared options constantly
    //  exists.
    app.useGlobalPipes(new ValidationPipe(VALIDATION_PIPE_OPTIONS));
    await app.init();
    fastify = app.getHttpAdapter().getInstance();
  });

  afterAll(async () => {
    await app.close();
  });

  const get = (url: string) => fastify.inject({ method: 'GET', url });

  describe('Fastify default query parser', () => {
    it('parses a repeated key into an array', async () => {
      const res = await get('/echo?status=scheduled&status=in_progress');
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        status: ['scheduled', 'in_progress'],
      });
    });

    it('parses a single-occurrence key as a plain string, not an array', async () => {
      const res = await get('/echo?status=scheduled');
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: 'scheduled' });
    });

    it('does not parse bracket style — "status[]" is a literal key and "status" is absent', async () => {
      const res = await get('/echo?status[]=scheduled&status[]=in_progress');
      expect(res.statusCode).toBe(200);
      const query = res.json<Record<string, unknown>>();
      expect(query['status']).toBeUndefined();
      expect(query['status[]']).toEqual(['scheduled', 'in_progress']);
    });
  });

  describe('ListJobsQueryDto through the ValidationPipe (mirrors main.ts config)', () => {
    it('normalizes a single repeat-style value into a one-element array', async () => {
      const res = await get('/jobs?status=scheduled');
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: ['scheduled'], scope: null });
    });

    it('accepts a repeat-style array of valid enum values', async () => {
      const res = await get('/jobs?status=scheduled&status=in_progress');
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        status: ['scheduled', 'in_progress'],
        scope: null,
      });
    });

    it('rejects a mixed valid+invalid repeat-style array with 422', async () => {
      // @IsEnum(..., { each: true }) rejects the WHOLE array when any member is
      // invalid — values are never filtered down to the valid ones.
      const res = await get('/jobs?status=scheduled&status=bogus_status');
      expect(res.statusCode).toBe(422);
    });

    it('rejects an invalid enum value with 422', async () => {
      const res = await get('/jobs?status=bogus_status');
      expect(res.statusCode).toBe(422);
    });

    it('rejects an empty value with 422 (toArray turns "" into [""])', async () => {
      const res = await get('/jobs?status=');
      expect(res.statusCode).toBe(422);
    });

    it('strips unknown keys silently (whitelist: true)', async () => {
      // forbidNonWhitelisted is false, so a key the DTO doesn't declare is
      // dropped rather than rejected — a client sending a stray param still
      // gets 200, not a 422.
      const res = await get('/jobs?foo=bar&status=scheduled');
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: ['scheduled'], scope: null });
    });

    it('lets bracket style through untouched — validation never sees it (the silent-ignore trap)', async () => {
      // A bogus value in bracket style is NOT a 422: the parser never produced a
      // `status` key, so the DTO validated an empty query. This is exactly how a
      // bracket-style client gets unfiltered results with no error.
      const res = await get('/jobs?status[]=bogus_status');
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: null, scope: null });
    });
  });

  describe('scope param through the ValidationPipe', () => {
    it.each(Object.values(JobListScope))('accepts scope=%s', async (scope) => {
      const res = await get(`/jobs?scope=${scope}`);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: null, scope });
    });

    it('rejects an unknown scope with 422', async () => {
      const res = await get('/jobs?scope=bogus_scope');
      expect(res.statusCode).toBe(422);
    });

    it('rejects scope + date with 422 for every non-today scope', async () => {
      for (const scope of ['upcoming', 'overdue', 'history']) {
        const res = await get(`/jobs?scope=${scope}&date=2026-06-20`);
        expect(res.statusCode).toBe(422);
      }
    });

    it('accepts scope=today + date (today is the default scope; date re-anchors it)', async () => {
      const res = await get('/jobs?scope=today&date=2026-06-20');
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        status: null,
        scope: JobListScope.TODAY,
      });
    });

    it('accepts a plain date without scope (no scope = no cross-field conflict)', async () => {
      const res = await get('/jobs?date=2026-06-20');
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: null, scope: null });
    });

    it('treats a whitespace-padded valid scope as valid (trim transformer)', async () => {
      const res = await get('/jobs?scope=%20upcoming%20');
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        status: null,
        scope: JobListScope.UPCOMING,
      });
    });
  });
});
