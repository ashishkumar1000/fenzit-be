import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  HttpException,
  InternalServerErrorException,
} from '@nestjs/common';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { SupabaseClientFactory } from '../common/factories/supabase-client.factory';
import { ErrorCode } from '../common/enums/error-code.enum';
import { RequestUser } from '../common/interfaces/request-user.interface';
import { Role } from '../common/enums/role.enum';
import { ReportQueuePauseDto } from './dto/report-queue-pause.dto';
import { MAX_PAUSE_MINUTES, ReportQueueService } from './report-queue.service';

/**
 * The report-queue pause (23-8): the panel state read (getState), the
 * worker's paused-tenant read (pausedTenantIds) and the pause/resume
 * writes. The load-bearing contract is the EXPIRY reading: an expired
 * timed pause reads as "running" — the same truth to the panel and the
 * worker — and the state read answers ISO-Z like the pause POST does
 * (Postgres serialises timestamptz as `+00:00`).
 */

const TENANT = 'tenant-uuid';
const OWNER = 'owner-uuid';

const user: RequestUser = {
  userId: OWNER,
  tenantId: TENANT,
  role: Role.COMPANY_ADMIN,
  platformAdmin: false,
  rawJwt: 'mock-jwt',
};

const noTenantUser: RequestUser = { ...user, tenantId: null };

/** Far-future / far-past instants — real-clock-proof. */
const FUTURE = '2126-01-01T00:00:00+00:00';
const PAST = '2000-01-01T00:00:00+00:00';
const NOW = '2026-11-18T08:00:00+00:00';

describe('ReportQueueService (23-8)', () => {
  let service: ReportQueueService;
  let supabaseClientFactory: jest.Mocked<SupabaseClientFactory>;

  /** The readRow chain: select(cols).eq('tenant_id', ...).maybeSingle(). */
  function rowChain(result: { data: unknown; error: unknown }) {
    const maybeSingle = jest.fn().mockResolvedValue(result);
    const eq = jest.fn().mockReturnValue({ maybeSingle });
    const select = jest.fn().mockReturnValue({ eq });
    return { select, eq, maybeSingle };
  }

  /**
   * The worker's set read: select(cols).eq('paused', true), awaited
   * directly — the tail must be thenable resolving `result`.
   */
  function pausedSetQb(result: { data: unknown; error: unknown }) {
    const qb = {} as Record<string, jest.Mock> & { then: jest.Mock };
    for (const m of ['select', 'eq']) {
      qb[m] = jest.fn().mockReturnValue(qb);
    }
    qb.then = jest.fn((resolve: (v: unknown) => unknown) => resolve(result));
    return qb;
  }

  /**
   * `from` dispatches on the first chained method / its arguments:
   * select('tenant_id, paused, paused_until, ...') is the row read,
   * select('tenant_id, paused, paused_until') the worker's set read,
   * upsert the pause/resume write.
   */
  function mockAdmin(opts: {
    row?: { data: unknown; error: unknown };
    pausedSet?: { data: unknown; error: unknown };
    upsertError?: unknown;
  }) {
    const rowQb = rowChain(opts.row ?? { data: null, error: null });
    const setQb = pausedSetQb(opts.pausedSet ?? { data: [], error: null });
    const upsert = jest
      .fn()
      .mockResolvedValue({ error: opts.upsertError ?? null });
    const from = jest.fn((table: string) => {
      if (table !== 'report_queue_pauses') {
        throw new Error(`unexpected table ${table}`);
      }
      return {
        select: jest.fn((cols: string) => {
          if (cols.includes('paused_by')) {
            return rowQb;
          }
          return setQb;
        }),
        upsert,
      };
    });
    supabaseClientFactory.createAdmin.mockReturnValue({ from } as never);
    return { from, upsert, rowQb, setQb };
  }

  beforeEach(async () => {
    const mockFactory = { create: jest.fn(), createAdmin: jest.fn() };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReportQueueService,
        { provide: SupabaseClientFactory, useValue: mockFactory },
      ],
    }).compile();
    service = module.get<ReportQueueService>(ReportQueueService);
    supabaseClientFactory = module.get(SupabaseClientFactory);
  });

  describe('getState — the panel view', () => {
    it('a tenant with no pause row reads as running with nulls', async () => {
      mockAdmin({ row: { data: null, error: null } });

      expect(await service.getState(user)).toEqual({
        paused: false,
        pausedUntil: null,
        pausedBy: null,
        pausedAt: null,
      });
    });

    it('an indefinite pause reads paused=true with the row pausedBy, ISO-Z pausedAt', async () => {
      mockAdmin({
        row: {
          data: {
            tenant_id: TENANT,
            paused: true,
            paused_until: null,
            paused_by: OWNER,
            paused_at: NOW,
          },
          error: null,
        },
      });

      const state = await service.getState(user);

      expect(state.paused).toBe(true);
      expect(state.pausedUntil).toBeNull();
      expect(state.pausedBy).toBe(OWNER);
      // One timestamp format whichever endpoint the panel reads: the row's
      // `+00:00` serialisation is normalised to the POST's ISO-Z.
      expect(state.pausedAt).toBe(new Date(NOW).toISOString());
      expect(state.pausedAt).toMatch(/Z$/);
    });

    it('a timed pause in the future reads paused=true with a normalised pausedUntil', async () => {
      mockAdmin({
        row: {
          data: {
            tenant_id: TENANT,
            paused: true,
            paused_until: FUTURE,
            paused_by: OWNER,
            paused_at: NOW,
          },
          error: null,
        },
      });

      const state = await service.getState(user);

      expect(state.paused).toBe(true);
      expect(state.pausedUntil).toBe(new Date(FUTURE).toISOString());
      expect(state.pausedUntil).toMatch(/Z$/);
      expect(state.pausedBy).toBe(OWNER);
    });

    it('an EXPIRED timed pause reads as running — the truth the panel and the worker share', async () => {
      mockAdmin({
        row: {
          data: {
            tenant_id: TENANT,
            paused: true,
            paused_until: PAST,
            paused_by: OWNER,
            paused_at: NOW,
          },
          error: null,
        },
      });

      expect(await service.getState(user)).toEqual({
        paused: false,
        pausedUntil: null,
        pausedBy: null,
        pausedAt: null,
      });
    });

    it('a paused=false row reads as running', async () => {
      mockAdmin({
        row: {
          data: {
            tenant_id: TENANT,
            paused: false,
            paused_until: null,
            paused_by: OWNER,
            paused_at: NOW,
          },
          error: null,
        },
      });

      expect((await service.getState(user)).paused).toBe(false);
    });

    it('a read failure is a 500 naming the read — never a silent "running"', async () => {
      mockAdmin({ row: { data: null, error: { message: 'db down' } } });

      await expect(service.getState(user)).rejects.toBeInstanceOf(
        InternalServerErrorException,
      );
    });

    it('the row read is tenant-scoped — the eq filter is load-bearing (isolation)', async () => {
      const { rowQb } = mockAdmin({ row: { data: null, error: null } });

      await service.getState(user);

      expect(rowQb.eq).toHaveBeenCalledWith('tenant_id', TENANT);
    });
  });

  describe('pausedTenantIds — the worker read', () => {
    it('returns only live pauses: indefinite and future, never expired', async () => {
      mockAdmin({
        pausedSet: {
          data: [
            { tenant_id: 't-indefinite', paused_until: null },
            { tenant_id: 't-timed', paused_until: FUTURE },
            { tenant_id: 't-expired', paused_until: PAST },
          ],
          error: null,
        },
      });

      const set = await service.pausedTenantIds();

      expect([...set].sort()).toEqual(['t-indefinite', 't-timed']);
      expect(set.has('t-expired')).toBe(false);
    });

    it('fails OPEN on a read error — a broken read must never wedge the queue', async () => {
      mockAdmin({ pausedSet: { data: null, error: { message: 'db down' } } });

      expect(await service.pausedTenantIds()).toEqual(new Set());
    });

    it('reads ONLY paused rows — the eq filter is load-bearing (a dropped filter would fence running tenants)', async () => {
      const { setQb } = mockAdmin({});

      await service.pausedTenantIds();

      expect(setQb.eq).toHaveBeenCalledWith('paused', true);
    });

    it('a corrupt paused_until string (NaN) reads EXPIRED — never wedges the fence', async () => {
      mockAdmin({
        row: {
          data: {
            tenant_id: TENANT,
            paused: true,
            paused_until: 'garbage',
            paused_by: OWNER,
            paused_at: NOW,
          },
          error: null,
        },
        pausedSet: {
          data: [{ tenant_id: 't-corrupt', paused_until: 'garbage' }],
          error: null,
        },
      });

      const set = await service.pausedTenantIds();

      // NaN > Date.now() is false → the corrupt row drops out, the queue
      // keeps flowing (fail-open, same direction as a read failure) — and
      // the panel reads it as running, not stuck-paused.
      expect(set.has('t-corrupt')).toBe(false);
      expect(await service.getState(user)).toEqual({
        paused: false,
        pausedUntil: null,
        pausedBy: null,
        pausedAt: null,
      });
    });
  });

  describe('pause / resume', () => {
    it('refuses a user with no company membership before any DB call', async () => {
      const { upsert } = mockAdmin({});

      await expect(service.pause(noTenantUser, 60)).rejects.toMatchObject({
        response: {
          error_code: ErrorCode.VALIDATION_ERROR,
          message: 'Company setup required before using the report queue',
        },
      });
      // getState refuses the same way (the status read has no company either).
      await expect(service.getState(noTenantUser)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      await expect(service.resume(noTenantUser)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(upsert).not.toHaveBeenCalled();
    });

    it('a timed pause upserts paused=true with the computed end and the actor, and answers the panel state', async () => {
      const { upsert } = mockAdmin({});

      const state = await service.pause(user, 60);

      expect(upsert).toHaveBeenCalledTimes(1);
      const payload = upsert.mock.calls[0][0] as Record<string, unknown>;
      expect(payload.tenant_id).toBe(TENANT);
      expect(payload.paused).toBe(true);
      expect(payload.paused_by).toBe(OWNER);
      expect(payload.paused_at).toEqual(expect.any(String));
      // paused_until ≈ now + 60 min.
      expect(
        Date.parse(payload['paused_until'] as string) - Date.now(),
      ).toBeGreaterThan(59 * 60_000);
      expect(
        Date.parse(payload['paused_until'] as string) - Date.now(),
      ).toBeLessThan(60 * 60_000);

      expect(state).toEqual({
        paused: true,
        pausedUntil: payload['paused_until'],
        pausedBy: OWNER,
        pausedAt: expect.any(String),
      });
    });

    it('a pause without minutes is indefinite — paused_until null', async () => {
      const { upsert } = mockAdmin({});

      const state = await service.pause(user, null);

      expect(upsert.mock.calls[0][0]).toMatchObject({
        tenant_id: TENANT,
        paused: true,
        paused_until: null,
        paused_by: OWNER,
      });
      expect(state.pausedUntil).toBeNull();
    });

    it('a zero-minute pause reads indefinite — the service never leans on JS falsiness (0 is unreachable over HTTP: DTO @Min(1))', async () => {
      const { upsert } = mockAdmin({});

      const state = await service.pause(user, 0);

      expect(upsert.mock.calls[0][0]).toMatchObject({
        tenant_id: TENANT,
        paused: true,
        paused_until: null,
      });
      expect(state.pausedUntil).toBeNull();
    });

    it('a failed upsert is a 500 — never a false "paused" answer', async () => {
      mockAdmin({ upsertError: { message: 'db down' } });

      await expect(service.pause(user, 60)).rejects.toBeInstanceOf(
        HttpException,
      );
    });

    it('resume upserts paused=false with a cleared end, and answers running with nulls', async () => {
      const { upsert } = mockAdmin({});

      const state = await service.resume(user);

      expect(upsert.mock.calls[0][0]).toMatchObject({
        tenant_id: TENANT,
        paused: false,
        paused_until: null,
      });
      expect(state).toEqual({
        paused: false,
        pausedUntil: null,
        pausedBy: null,
        pausedAt: null,
      });
    });
  });

  /** The minute cap lives on the HTTP surface (the DTO's validators), not
   *  the service — pin the BOUNDARY, not the constant. */
  describe('the pause minutes window (DTO boundary, 23-8 second pass)', () => {
    const validateDto = (body: Record<string, unknown>) =>
      validate(plainToInstance(ReportQueuePauseDto, body));

    it('minutes 0 and 1441 are refused; 1 and the 1440 cap are accepted; absent is legal (indefinite)', async () => {
      expect((await validateDto({ minutes: 0 })).length).toBeGreaterThan(0);
      expect((await validateDto({ minutes: -5 })).length).toBeGreaterThan(0);
      expect((await validateDto({ minutes: 1441 })).length).toBeGreaterThan(0);
      expect(await validateDto({ minutes: 1 })).toEqual([]);
      expect(await validateDto({ minutes: 1440 })).toEqual([]);
      expect(await validateDto({})).toEqual([]);
    });

    it('the service constant still names the cap the DTO uses', () => {
      expect(MAX_PAUSE_MINUTES).toBe(1440);
    });
  });
});
