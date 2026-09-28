import 'reflect-metadata';
import { HttpException } from '@nestjs/common';
import { CheckInOutService } from './check-in-out.service';
import { PgPoolFactory } from '../common/pg/pg-pool.factory';
import { RequestUser } from '../common/interfaces/request-user.interface';
import { Role } from '../common/enums/role.enum';
import { CheckInOutDto } from './dto/check-in-out.dto';

/**
 * Check-in/out orchestration (16-1/16-2) against a fake PoolClient whose
 * `query` routes on the SQL text. This pins the DECISIONS — lock order,
 * replay short-circuit, the AD-15 budget, the D3 ladder, the AD-13 alert —
 * while the real-DB journey spec proves the SQL itself.
 */

const tech: RequestUser = {
  userId: '11111111-1111-4111-8111-111111111111',
  tenantId: '22222222-2222-4222-8222-222222222222',
  role: Role.TECHNICIAN,
  rawJwt: 'mock-jwt',
};

const OFFICE = {
  office_id: 'office-1',
  office_name: 'Thane',
  office_lat: 19.076,
  office_lng: 72.8777,
  radius_m: 100,
};

const RULE = {
  id: 'rule-1',
  valid: '[2026-01-01,)',
  start_time: '09:00:00',
  end_time: '18:00:00',
  late_cutoff_minutes: 15,
};

const RECORD = {
  id: 'record-1',
  work_date: '2026-09-28',
  office_id: 'office-1',
  office_rules_id: 'rule-1',
  radius_m: 100,
  checkin_at: '2026-09-28T04:00:00Z', // 09:30 IST
  checkout_at: null,
};

const OK_FIX = {
  latitude: 19.07605,
  longitude: 72.87775,
  accuracyM: 8,
  mocked: false,
  provider: 'fused',
  fixAgeMs: 900,
};

const CHECKIN_KEY = '33333333-3333-4333-8333-333333333333';
const CHECKOUT_KEY = '44444444-4444-4444-8444-444444444444';

function dto(overrides: Partial<typeof OK_FIX> = {}): CheckInOutDto {
  return Object.assign(new CheckInOutDto(), { ...OK_FIX, ...overrides });
}

type QueryFn = (sql: string) => { rows: unknown[]; rowCount: number };

/** Builds a fake tx whose answers come from `router`; everything recorded. */
function fakeTx(router: QueryFn) {
  const queries: { sql: string; params?: unknown[] }[] = [];
  return {
    queries,
    query: jest.fn((sql: string, params?: unknown[]) => {
      queries.push({ sql, params });
      return Promise.resolve(router(sql));
    }),
  };
}

function serviceWith(tx: ReturnType<typeof fakeTx>): CheckInOutService {
  const pg = {
    withTransaction: (work: (client: unknown) => Promise<unknown>) => work(tx),
  } as unknown as PgPoolFactory;
  return new CheckInOutService(pg);
}

/** The default happy routing — every read answered, writes accepted. */
function happyRouter(
  overrides: {
    /** 1st findRecordByEmployeeDate read (the pre-check). */
    preRecord?: unknown;
    /** Later findRecordByEmployeeDate reads (the post-write read-back). */
    record?: unknown;
    /** findRecordByAttemptId (the AD-6 replay rebuild). */
    attemptRecord?: unknown;
    replay?: unknown;
    blockedUntil?: unknown;
    /** findActiveLeaveForDate (the AD-22 leave seam, spec-17 D3/D11). */
    leave?: unknown;
  } = {},
): QueryFn {
  let recordReads = 0;
  return (sql) => {
    if (sql.includes('attendance_lock')) return { rows: [], rowCount: 0 };
    if (sql.includes('select now() as now'))
      return { rows: [{ now: new Date() }], rowCount: 1 };
    // Must precede the timezone read — both query public.tenants.
    if (sql.includes('select owner_id from public.tenants'))
      return { rows: [{ owner_id: 'owner-1' }], rowCount: 1 };
    if (sql.includes('attendance_today'))
      return { rows: [{ today: '2026-09-28' }], rowCount: 1 };
    if (sql.includes('request_id = $3'))
      return {
        rows: overrides.replay ? [overrides.replay] : [],
        rowCount: overrides.replay ? 1 : 0,
      };
    if (sql.includes('max(blocked_until)'))
      return {
        rows: [{ blocked_until: overrides.blockedUntil ?? null }],
        rowCount: 1,
      };
    if (sql.includes('from public.tenants where id = $1'))
      return { rows: [{ timezone: 'Asia/Kolkata' }], rowCount: 1 };
    if (sql.includes('attendance_settings'))
      return {
        rows: [{ enabled: true, setup_completed_at: '2026-09-01T04:00:00Z' }],
        rowCount: 1,
      };
    if (sql.includes('attendance_enrolments'))
      return {
        rows: [{ valid: '[2026-09-01,)', enabled_at: '2026-09-01T04:00:00Z' }],
        rowCount: 1,
      };
    if (sql.includes('attendance_office_assignments'))
      return { rows: [OFFICE], rowCount: 1 };
    if (sql.includes('attendance_office_rules'))
      return { rows: [RULE], rowCount: 1 };
    if (sql.includes('weekly_off_overrides')) return { rows: [], rowCount: 0 };
    if (sql.includes('weekly_off_defaults'))
      return { rows: [{ valid: '[2026-01-01,)', days: [7] }], rowCount: 1 };
    if (sql.includes('from public.holidays')) return { rows: [], rowCount: 0 };
    // Epic 17 seam (spec-17 D3/D11): the active leave row for the date,
    // present only when the FR-9 specs inject one.
    if (sql.includes('from public.leave_request_days'))
      return {
        rows: overrides.leave ? [overrides.leave] : [],
        rowCount: overrides.leave ? 1 : 0,
      };
    // FR-9 auto-cancel payload reads (spec-17 D11).
    if (sql.includes('select name from public.users'))
      return { rows: [{ name: 'Arya' }], rowCount: 1 };
    if (sql.includes('insert into public.leave_request_days'))
      return { rows: [], rowCount: 1 };
    if (sql.includes('update public.leave_request_days'))
      return { rows: [{ leave_date: '2026-09-28' }], rowCount: 1 };
    if (sql.includes('insert into public.leave_events'))
      return { rows: [], rowCount: 1 };
    if (sql.includes('insert into public.attendance_attempts'))
      return { rows: [{ id: 'attempt-1' }], rowCount: 1 };
    if (sql.includes('insert into public.attendance_records'))
      return { rows: [], rowCount: 1 };
    if (sql.includes('update public.attendance_records'))
      return { rows: [], rowCount: 1 };
    if (sql.includes('insert into public.notifications'))
      return { rows: [], rowCount: 1 };
    if (sql.includes('outcome = any'))
      return { rows: [{ n: '0' }], rowCount: 1 };
    if (sql.includes("outcome = 'mocked'")) return MOCKED_COUNT_DEFAULT;
    if (sql.includes('select id, name from public.users'))
      return { rows: [{ id: tech.userId, name: 'Arya' }], rowCount: 1 };
    if (sql.includes('checkin_attempt_id = $1'))
      return {
        rows: overrides.attemptRecord ? [overrides.attemptRecord] : [RECORD],
        rowCount: 1,
      };
    if (sql.includes('from public.attendance_records')) {
      recordReads++;
      const first =
        overrides.preRecord !== undefined ? [overrides.preRecord] : [];
      const rows =
        recordReads === 1
          ? first
          : overrides.record !== undefined
            ? [overrides.record]
            : first;
      return { rows, rowCount: rows.length };
    }
    throw new Error(`Unrouted SQL in test: ${sql}`);
  };
}

/** A router override layered on the happy path. */
function routerWith(
  patch: Partial<Record<string, { rows: unknown[]; rowCount: number }>>,
): QueryFn {
  const base = happyRouter();
  return (sql) => {
    for (const [fragment, answer] of Object.entries(patch)) {
      if (sql.includes(fragment)) return answer;
    }
    return base(sql);
  };
}

const MOCKED_COUNT_DEFAULT = {
  rows: [{ n: '0', month: '2026-09' }],
  rowCount: 1,
};

async function rejectionOf(promise: Promise<unknown>): Promise<HttpException> {
  try {
    await promise;
  } catch (err) {
    return err as HttpException;
  }
  throw new Error('Expected the promise to reject');
}

function attemptOutcomeOf(tx: ReturnType<typeof fakeTx>): unknown {
  const insert = tx.queries.find((q) =>
    q.sql.includes('insert into public.attendance_attempts'),
  );
  // outcome is the 5th positional parameter.
  return insert?.params?.[4];
}

describe('CheckInOutService — check-in (16-1)', () => {
  it('locks tenant then employee, in order (AD-5)', async () => {
    const tx = fakeTx(happyRouter({ preRecord: null, record: RECORD }));
    const svc = serviceWith(tx);
    await svc.checkIn(tech, dto(), CHECKIN_KEY);
    const lockCalls = tx.queries.filter((q) =>
      q.sql.includes('attendance_lock'),
    );
    expect(lockCalls).toHaveLength(2);
    expect(lockCalls[0].sql).toContain('attendance_lock_tenant');
    expect(lockCalls[1].sql).toContain('attendance_lock_employee');
  });

  it('accepts an in-radius fix: attempt(ok) + record insert + stored-instant response', async () => {
    const tx = fakeTx(happyRouter({ preRecord: null, record: RECORD }));
    const svc = serviceWith(tx);

    const response = await svc.checkIn(tech, dto(), CHECKIN_KEY);

    expect(response.workDate).toBe('2026-09-28');
    expect(response.checkinAt).toBe('2026-09-28T09:30:00+05:30');
    // 09:30 IST vs 09:00 start + 15 cut-off → 15 late.
    expect((response as { lateMinutes: number }).lateMinutes).toBe(15);
    expect((response as { isLate: boolean }).isLate).toBe(true);

    const attemptInsert = tx.queries.find((q) =>
      q.sql.includes('insert into public.attendance_attempts'),
    );
    expect(attemptInsert?.params).toEqual(
      expect.arrayContaining([
        'check_in',
        'ok',
        8,
        expect.any(Number),
        false,
        'fused',
        900,
      ]),
    );
    const recordInsert = tx.queries.find((q) =>
      q.sql.includes('insert into public.attendance_records'),
    );
    expect(recordInsert).toBeDefined();
    // Distance ~5 m for the tiny offset — under the 100 m radius (param 10).
    const distance = recordInsert?.params?.[10] as number;
    expect(distance).toBeGreaterThan(0);
    expect(distance).toBeLessThan(10);
  });

  it('replays the stored outcome without a second attempt row (AD-6)', async () => {
    const replay = {
      id: 'attempt-0',
      kind: 'check_in',
      outcome: 'ok',
      distance_m: 5.6,
      radius_m: 100,
      blocked_until: null,
      attempted_at: '2026-09-28T04:00:00Z',
    };
    const tx = fakeTx(happyRouter({ replay, attemptRecord: RECORD }));
    const svc = serviceWith(tx);

    const response = await svc.checkIn(tech, dto(), CHECKIN_KEY);

    expect(response.workDate).toBe('2026-09-28');
    const inserts = tx.queries.filter((q) =>
      q.sql.includes('insert into public.attendance_attempts'),
    );
    expect(inserts).toHaveLength(0);
  });

  it('replays a rejected outcome as the same HTTP error, no writes', async () => {
    const replay = {
      id: 'attempt-0',
      kind: 'check_in',
      outcome: 'too_far',
      distance_m: 600,
      radius_m: 100,
      blocked_until: null,
      attempted_at: '2026-09-28T04:00:00Z',
    };
    const tx = fakeTx(happyRouter({ replay }));
    const svc = serviceWith(tx);

    const err = await rejectionOf(svc.checkIn(tech, dto(), CHECKIN_KEY));
    expect(err.getStatus()).toBe(422);
    expect(tx.queries.some((q) => q.sql.includes('insert into'))).toBe(false);
  });

  it('answers 429 and records (not counts) under an active block (AD-15)', async () => {
    const tx = fakeTx(happyRouter({ blockedUntil: '2026-09-28T10:00:00Z' }));
    const svc = serviceWith(tx);

    const err = await rejectionOf(svc.checkIn(tech, dto(), CHECKIN_KEY));
    expect(err.getStatus()).toBe(429);
    expect(attemptOutcomeOf(tx)).toBe('rate_limited');
    // The context was never read — the block needs nothing from it.
    expect(
      tx.queries.some((q) => q.sql.includes('attendance_office_assignments')),
    ).toBe(false);
  });

  it('records not_tracked and answers 403 when enrolment does not cover today', async () => {
    const tx = fakeTx(
      routerWith({ attendance_enrolments: { rows: [], rowCount: 0 } }),
    );
    const svc = serviceWith(tx);

    const err = await rejectionOf(svc.checkIn(tech, dto(), CHECKIN_KEY));
    expect(err.getStatus()).toBe(403);
    expect(attemptOutcomeOf(tx)).toBe('not_tracked');
  });

  it('records already_checked_in when today has a record (409, not counted)', async () => {
    const tx = fakeTx(happyRouter({ preRecord: RECORD }));
    const svc = serviceWith(tx);

    const err = await rejectionOf(svc.checkIn(tech, dto(), CHECKIN_KEY));
    expect(err.getStatus()).toBe(409);
    expect((err.getResponse() as Record<string, unknown>)['error_code']).toBe(
      'ATTENDANCE_ALREADY_CHECKED_IN',
    );
    expect(attemptOutcomeOf(tx)).toBe('already_checked_in');
  });

  it.each([
    ['stale_fix', 'ATTENDANCE_STALE_FIX', { fixAgeMs: 40_000 }],
    ['low_accuracy', 'ATTENDANCE_LOW_ACCURACY', { accuracyM: 150 }],
  ])('records %s as a counted 422', async (outcome, code, badFields) => {
    const tx = fakeTx(happyRouter());
    const svc = serviceWith(tx);

    const err = await rejectionOf(
      svc.checkIn(tech, dto(badFields), CHECKIN_KEY),
    );
    expect(err.getStatus()).toBe(422);
    expect((err.getResponse() as Record<string, unknown>)['error_code']).toBe(
      code,
    );
    expect(attemptOutcomeOf(tx)).toBe(outcome);
  });

  it('too_far carries distanceM/radiusM and the office name', async () => {
    const tx = fakeTx(happyRouter());
    const svc = serviceWith(tx);

    const err = await rejectionOf(
      svc.checkIn(
        tech,
        dto({ latitude: 28.6139, longitude: 77.209 }), // Delhi, ~1150 km away
        CHECKIN_KEY,
      ),
    );
    expect(err.getStatus()).toBe(422);
    const body = err.getResponse() as Record<string, unknown>;
    expect(body['error_code']).toBe('ATTENDANCE_TOO_FAR');
    expect(body['radiusM']).toBe(100);
    expect(body['distanceM'] as number).toBeGreaterThan(1_000_000);
    expect(String(body['message'])).toContain('Thane');
  });

  it('D3 priority: too_far beats mocked (the alert counts only valid-location attempts)', async () => {
    const tx = fakeTx(happyRouter());
    const svc = serviceWith(tx);

    const err = await rejectionOf(
      svc.checkIn(
        tech,
        dto({ latitude: 28.6139, longitude: 77.209, mocked: true }),
        CHECKIN_KEY,
      ),
    );
    expect((err.getResponse() as Record<string, unknown>)['error_code']).toBe(
      'ATTENDANCE_TOO_FAR',
    );
    expect(
      tx.queries.some((q) =>
        q.sql.includes('insert into public.notifications'),
      ),
    ).toBe(false);
  });

  it('D3 full ladder: stale > low_accuracy > too_far > mocked, exactly one outcome each', async () => {
    const svc = serviceWith(fakeTx(happyRouter()));
    const far = { latitude: 28.6139, longitude: 77.209 };

    // All four wrong → stale_fix wins.
    const all = await rejectionOf(
      svc.checkIn(
        tech,
        dto({ ...far, accuracyM: 150, fixAgeMs: 40_000, mocked: true }),
        CHECKIN_KEY,
      ),
    );
    expect((all.getResponse() as Record<string, unknown>)['error_code']).toBe(
      'ATTENDANCE_STALE_FIX',
    );

    // Three wrong (no stale) → low_accuracy.
    const three = await rejectionOf(
      svc.checkIn(
        tech,
        dto({ ...far, accuracyM: 150, mocked: true }),
        CHECKIN_KEY,
      ),
    );
    expect((three.getResponse() as Record<string, unknown>)['error_code']).toBe(
      'ATTENDANCE_LOW_ACCURACY',
    );
  });

  it('mocked is recorded and the 3rd of the month alerts the owner (AD-13/D5)', async () => {
    const tx = fakeTx(
      routerWith({
        "outcome = 'mocked'": {
          rows: [{ n: '3', month: '2026-09' }],
          rowCount: 1,
        },
      }),
    );
    const svc = serviceWith(tx);

    const err = await rejectionOf(
      svc.checkIn(tech, dto({ mocked: true }), CHECKIN_KEY),
    );
    expect(err.getStatus()).toBe(422);
    expect(attemptOutcomeOf(tx)).toBe('mocked');

    const alert = tx.queries.find((q) =>
      q.sql.includes('insert into public.notifications'),
    );
    expect(alert).toBeDefined();
    // The event type and entity type are registry-bound parameters now.
    const params = alert?.params ?? [];
    expect(params).toEqual(
      expect.arrayContaining([
        'attendance.fake_location',
        'attendance',
        'owner-1',
        'Arya',
        expect.any(String), // month
        3,
      ]),
    );
    const dedupeKey = params.find(
      (p): p is string =>
        typeof p === 'string' && p.includes(':attendance.fake_location:'),
    );
    expect(dedupeKey).toMatch(
      /^22222222-2222-4222-8222-222222222222:attendance\.fake_location:owner-1:11111111-1111-4111-8111-111111111111:\d{4}-\d{2}$/,
    );
  });

  it('mocked 2nd of the month alerts nobody', async () => {
    const tx = fakeTx(
      routerWith({
        "outcome = 'mocked'": {
          rows: [{ n: '2', month: '2026-09' }],
          rowCount: 1,
        },
      }),
    );
    const svc = serviceWith(tx);

    await expect(
      svc.checkIn(tech, dto({ mocked: true }), CHECKIN_KEY),
    ).rejects.toThrow(HttpException);
    expect(
      tx.queries.some((q) =>
        q.sql.includes('insert into public.notifications'),
      ),
    ).toBe(false);
  });

  it('the 5th counted rejection in the window arms blocked_until (AD-15)', async () => {
    const tx = fakeTx(
      routerWith({ 'outcome = any': { rows: [{ n: '4' }], rowCount: 1 } }),
    );
    const svc = serviceWith(tx);

    const err = await rejectionOf(
      svc.checkIn(
        tech,
        dto({ latitude: 28.6139, longitude: 77.209 }),
        CHECKIN_KEY,
      ),
    );
    expect(err.getStatus()).toBe(422);

    const attemptInsert = tx.queries.find((q) =>
      q.sql.includes('insert into public.attendance_attempts'),
    );
    const blockedUntil = attemptInsert?.params?.[13] as string | null;
    expect(blockedUntil).not.toBeNull();
    expect(new Date(blockedUntil as string).getTime()).toBeGreaterThan(
      Date.now(),
    );
  });

  it('the 4th counted rejection does NOT arm the block', async () => {
    const tx = fakeTx(
      routerWith({ 'outcome = any': { rows: [{ n: '3' }], rowCount: 1 } }),
    );
    const svc = serviceWith(tx);

    await rejectionOf(
      svc.checkIn(
        tech,
        dto({ latitude: 28.6139, longitude: 77.209 }),
        CHECKIN_KEY,
      ),
    );
    const attemptInsert = tx.queries.find((q) =>
      q.sql.includes('insert into public.attendance_attempts'),
    );
    expect(attemptInsert?.params?.[13]).toBeNull();
  });
});

describe('CheckInOutService — check-out (16-2)', () => {
  const checkedInRecord = { ...RECORD, checkout_at: null };
  const checkedOutRecord = {
    ...RECORD,
    checkout_at: '2026-09-28T10:00:00Z', // 15:30 IST — 2.5h before 18:00 end
  };

  it('records not_checked_in (409) with no record today', async () => {
    const tx = fakeTx(happyRouter());
    const svc = serviceWith(tx);

    const err = await rejectionOf(svc.checkOut(tech, dto(), CHECKOUT_KEY));
    expect(err.getStatus()).toBe(409);
    expect((err.getResponse() as Record<string, unknown>)['error_code']).toBe(
      'ATTENDANCE_NOT_CHECKED_IN',
    );
    expect(attemptOutcomeOf(tx)).toBe('not_checked_in');
  });

  it('records already_checked_out (409) when the day is closed', async () => {
    const tx = fakeTx(happyRouter({ preRecord: checkedOutRecord }));
    const svc = serviceWith(tx);

    const err = await rejectionOf(svc.checkOut(tech, dto(), CHECKOUT_KEY));
    expect(err.getStatus()).toBe(409);
    expect((err.getResponse() as Record<string, unknown>)['error_code']).toBe(
      'ATTENDANCE_ALREADY_CHECKED_OUT',
    );
    expect(attemptOutcomeOf(tx)).toBe('already_checked_out');
  });

  it('checks out onto the SAME row and reports worked minutes + early checkout', async () => {
    // Pre-check must see the OPEN record; the post-write read-back the
    // closed one (the router counts record reads).
    const tx = fakeTx(
      happyRouter({ preRecord: checkedInRecord, record: checkedOutRecord }),
    );
    const svc = serviceWith(tx);

    const response = (await svc.checkOut(tech, dto(), CHECKOUT_KEY)) as Record<
      string,
      unknown
    >;

    const update = tx.queries.find((q) =>
      q.sql.includes('update public.attendance_records'),
    );
    expect(update).toBeDefined();
    expect(update?.params).toEqual(
      expect.arrayContaining(['record-1', 'attempt-1']),
    );
    expect(response).toMatchObject({
      workDate: '2026-09-28',
      checkinAt: '2026-09-28T09:30:00+05:30',
      checkoutAt: '2026-09-28T15:30:00+05:30',
      workedMinutes: 360, // 09:30 → 15:30
      earlyCheckout: true,
      earlyCheckoutMinutes: 150, // 18:00 − 15:30
    });
  });

  it('a check-out after End is not early', async () => {
    const lateOut = {
      ...checkedInRecord,
      checkout_at: '2026-09-28T13:10:00Z',
    }; // 18:40 IST
    const tx = fakeTx(
      happyRouter({ preRecord: checkedInRecord, record: lateOut }),
    );
    const svc = serviceWith(tx);

    const response = (await svc.checkOut(tech, dto(), CHECKOUT_KEY)) as Record<
      string,
      unknown
    >;
    expect(response).toMatchObject({
      earlyCheckout: false,
      earlyCheckoutMinutes: null,
    });
  });

  it('same gates apply: a too_far check-out never reaches the record', async () => {
    const tx = fakeTx(happyRouter({ preRecord: checkedInRecord }));
    const svc = serviceWith(tx);

    const err = await rejectionOf(
      svc.checkOut(
        tech,
        dto({ latitude: 28.6139, longitude: 77.209 }),
        CHECKOUT_KEY,
      ),
    );
    expect(err.getStatus()).toBe(422);
    expect((err.getResponse() as Record<string, unknown>)['error_code']).toBe(
      'ATTENDANCE_TOO_FAR',
    );
    expect(
      tx.queries.some((q) =>
        q.sql.includes('update public.attendance_records'),
      ),
    ).toBe(false);
  });
});

/**
 * FR-9 (spec-17 D11): check-in × leave. The gate answers a committed
 * `leave_confirmation_required` 409 without the confirm flag; the
 * confirmed path cancels ONLY today's date after the location ladder
 * passes; half-days and off-days never gate; check-out is never gated.
 */
describe('CheckInOutService — check-in × leave (17-4, FR-9)', () => {
  const FULL_DAY_LEAVE = {
    state: 'approved',
    part: 'full_day',
    leave_request_db_id: 'leave-db-1',
    request_id: '66666666-6666-4666-8666-666666666666',
  };

  it('gates without confirm: committed attempt row + 409, nothing else written', async () => {
    const tx = fakeTx(happyRouter({ leave: FULL_DAY_LEAVE }));
    const service = serviceWith(tx);
    await expect(
      service.checkIn(tech, dto(), CHECKIN_KEY),
    ).rejects.toMatchObject({
      status: 409,
      response: { error_code: 'ATTENDANCE_LEAVE_CONFIRMATION_REQUIRED' },
    });
    const attempt = tx.queries.find((q) =>
      q.sql.includes('insert into public.attendance_attempts'),
    );
    expect(attempt?.params?.[4]).toBe('leave_confirmation_required');
    expect(
      tx.queries.some((q) =>
        q.sql.includes('insert into public.attendance_records'),
      ),
    ).toBe(false);
    expect(
      tx.queries.some((q) => q.sql.includes('insert into public.leave_events')),
    ).toBe(false);
  });

  it('with confirm: the record is written and ONLY today transitions to cancelled', async () => {
    const tx = fakeTx(
      happyRouter({ leave: FULL_DAY_LEAVE, preRecord: null, record: RECORD }),
    );
    const service = serviceWith(tx);
    const response = (await service.checkIn(
      tech,
      dto({ confirmLeaveCancel: true }),
      CHECKIN_KEY,
    )) as CheckInResponse;
    expect(response.workDate).toBe('2026-09-28');
    const update = tx.queries.find((q) =>
      q.sql.includes('update public.leave_request_days'),
    );
    expect(update?.params?.[2]).toEqual(['2026-09-28']); // today ONLY
    expect(update?.params?.[3]).toEqual(['pending', 'approved']);
    const event = tx.queries.find((q) =>
      q.sql.includes('insert into public.leave_events'),
    );
    expect(event?.params?.[3]).toBe('checkin_auto_cancel');
    const notification = tx.queries.find((q) =>
      q.sql.includes('insert into public.notifications'),
    );
    expect(notification?.params?.[1]).toBe('owner-1'); // the owner is notified
    expect(JSON.parse(notification?.params?.[3] as string)).toEqual({
      employeeName: 'Arya',
      leaveDate: '2026-09-28',
    });
  });

  it('a too_far fix with confirm stays 422 and leaves the leave untouched', async () => {
    const tx = fakeTx(happyRouter({ leave: FULL_DAY_LEAVE }));
    const service = serviceWith(tx);
    await expect(
      service.checkIn(
        tech,
        dto({ latitude: 28.6139, longitude: 77.209, confirmLeaveCancel: true }),
        CHECKIN_KEY,
      ),
    ).rejects.toMatchObject({ status: 422 });
    expect(
      tx.queries.some((q) =>
        q.sql.includes('update public.leave_request_days'),
      ),
    ).toBe(false);
    expect(
      tx.queries.some((q) => q.sql.includes('insert into public.leave_events')),
    ).toBe(false);
  });

  it('a HALF-day leave never gates and never cancels (FR-9 exception)', async () => {
    // second_half → the working half is the morning → the rule start (not
    // the midpoint) still governs late; and no leave row is touched.
    const tx = fakeTx(
      happyRouter({
        leave: { ...FULL_DAY_LEAVE, part: 'second_half' },
        preRecord: null,
        record: RECORD,
      }),
    );
    const service = serviceWith(tx);
    const response = (await service.checkIn(
      tech,
      dto(),
      CHECKIN_KEY,
    )) as CheckInResponse;
    expect(response.lateMinutes).toBe(15); // 09:30 check-in vs 09:00 + 15 cutoff → exactly at the grace edge
    expect(
      tx.queries.some((q) =>
        q.sql.includes('update public.leave_request_days'),
      ),
    ).toBe(false);
  });

  it('a first-half leave day computes late from the MIDPOINT (FR-7 via D3)', async () => {
    const tx = fakeTx(
      happyRouter({
        leave: { ...FULL_DAY_LEAVE, part: 'first_half' },
        preRecord: null,
        record: RECORD,
      }),
    );
    const service = serviceWith(tx);
    const response = (await service.checkIn(
      tech,
      dto(),
      CHECKIN_KEY,
    )) as CheckInResponse;
    // Rule 09:00–18:00 → midpoint 13:30 (+15 cutoff → 13:45); check-in 09:30 is BEFORE it → not late.
    expect(response.lateMinutes).toBe(0);
    expect(response.isLate).toBe(false);
  });

  it('a PENDING leave day gates the same way; confirm cancels from pending', async () => {
    const tx = fakeTx(
      happyRouter({ leave: { ...FULL_DAY_LEAVE, state: 'pending' } }),
    );
    const service = serviceWith(tx);
    await expect(
      service.checkIn(tech, dto(), CHECKIN_KEY),
    ).rejects.toMatchObject({ status: 409 });
    const ok = fakeTx(
      happyRouter({
        leave: { ...FULL_DAY_LEAVE, state: 'pending' },
        preRecord: null,
        record: RECORD,
      }),
    );
    await serviceWith(ok).checkIn(
      tech,
      dto({ confirmLeaveCancel: true }),
      CHECKIN_KEY,
    );
    const update = ok.queries.find((q) =>
      q.sql.includes('update public.leave_request_days'),
    );
    expect(update?.params?.[2]).toEqual(['2026-09-28']);
  });

  it('a weekly-off leave day (off day inside a span) never gates (D11)', async () => {
    // weekly_off_defaults already answers days: [7] (Sunday); make the date
    // a Sunday leave day — the gate requires isWorkingDay. The inner router
    // is created ONCE: its record-read counter must survive across reads.
    const inner = happyRouter({
      leave: FULL_DAY_LEAVE,
      preRecord: null,
      record: RECORD,
    });
    const sundayRouter: QueryFn = (sql) => {
      if (sql.includes('weekly_off_defaults')) {
        return {
          rows: [{ valid: '[2026-01-01,)', days: [1, 2, 3, 4, 5, 6, 7] }],
          rowCount: 1,
        };
      }
      return inner(sql);
    };
    const tx = fakeTx(sundayRouter);
    const service = serviceWith(tx);
    await service.checkIn(tech, dto(), CHECKIN_KEY);
    expect(
      tx.queries.some((q) =>
        q.sql.includes('update public.leave_request_days'),
      ),
    ).toBe(false);
  });

  it('check-OUT is never gated even on a full-day leave day (D11 scoping)', async () => {
    const tx = fakeTx(
      happyRouter({ leave: FULL_DAY_LEAVE, preRecord: RECORD, record: RECORD }),
    );
    const service = serviceWith(tx);
    await service.checkOut(
      tech,
      dto({ confirmLeaveCancel: false }),
      CHECKOUT_KEY,
    );
    expect(
      tx.queries.some(
        (q) =>
          q.sql.includes('insert into public.attendance_attempts') &&
          q.params?.[4] === 'leave_confirmation_required',
      ),
    ).toBe(false);
    expect(
      tx.queries.some((q) =>
        q.sql.includes('update public.leave_request_days'),
      ),
    ).toBe(false);
  });
});
