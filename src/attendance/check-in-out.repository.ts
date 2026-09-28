import { Logger } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { COUNTED_OUTCOMES, RATE_WINDOW_MINUTES } from './constants';
import { internalError } from './attendance-rpc.helpers';
import {
  ATTENDANCE_ENTITY_TYPE,
  ATTENDANCE_NOTIFICATION_EVENT,
} from './notification-events';

/**
 * SQL for check-in/out ATTEMPTS, locks and the fake-location alert
 * (16-1/16-2); the attendance_records statements live in
 * check-in-out.records.repository.ts. Every function receives the open
 * transaction client from `PgPoolFactory.withTransaction` — the AD-5 lock
 * order (shared tenant → exclusive employee) and the AD-6/AD-15 attempt
 * arithmetic only hold inside the one transaction. All statements are
 * parameterised; there are NO new SQL functions (AD-3 amendment) — this
 * file is the entire DB surface of check-in/out beyond the pre-existing
 * lock/today helpers.
 */

const logger = new Logger('CheckInOutRepository');

export type AttemptKind = 'check_in' | 'check_out';

export interface AttemptRow {
  id: string;
  kind: AttemptKind;
  outcome: string;
  distance_m: number | null;
  radius_m: number | null;
  blocked_until: Date | string | null;
  attempted_at: Date | string;
}

export interface AttemptLocation {
  latitude: number;
  longitude: number;
  accuracyM: number;
  distanceM: number | null;
  radiusM: number | null;
  mocked: boolean | null;
  provider: string | null;
  fixAgeMs: number | null;
}

/** The AD-5 employee lock — same key space the RPC-era helpers use. */
export async function lockEmployee(
  tx: PoolClient,
  employeeId: string,
): Promise<void> {
  await tx.query('select public.attendance_lock_employee($1)', [employeeId]);
}

/**
 * AD-6 replay probe: the stored attempt for (tenant_id, request_id).
 * Employee-scoped on purpose — a key belongs to ONE employee; another
 * employee presenting it must never read their attempt (review finding).
 */
export async function findAttemptByIdempotencyKey(
  tx: PoolClient,
  tenantId: string,
  employeeId: string,
  requestId: string,
): Promise<AttemptRow | null> {
  const result = await tx.query<AttemptRow>(
    `select id, kind, outcome, distance_m, radius_m, blocked_until, attempted_at
     from public.attendance_attempts
     where tenant_id = $1 and employee_id = $2 and request_id = $3`,
    [tenantId, employeeId, requestId],
  );
  return result.rows[0] ?? null;
}

/**
 * AD-15: the active block for this employee, if any. blocked_until lives
 * on the tripping attempt row; any row whose block is still in the future
 * means the employee is rate-limited.
 */
export async function readActiveBlockedUntil(
  tx: PoolClient,
  employeeId: string,
): Promise<Date | null> {
  const result = await tx.query<{ blocked_until: Date }>(
    `select max(blocked_until) as blocked_until
     from public.attendance_attempts
     where employee_id = $1 and blocked_until is not null and blocked_until > now()`,
    [employeeId],
  );
  const value = result.rows[0]?.blocked_until;
  return value ? new Date(value) : null;
}

/** The DB clock (AD-15/D5 arithmetic never mixes the app clock — review
 * finding: skew across a month boundary would double-fire the alert). */
export async function dbNow(tx: PoolClient): Promise<Date> {
  const result = await tx.query<{ now: Date }>('select now() as now');
  return new Date(result.rows[0].now);
}

/** AD-15: counted rejections still inside the window (this call excluded). */
export async function countCountedInWindow(
  tx: PoolClient,
  employeeId: string,
): Promise<number> {
  const result = await tx.query<{ n: string }>(
    `select count(*)::text as n from public.attendance_attempts
     where employee_id = $1 and outcome = any($2::text[])
       and attempted_at > now() - make_interval(mins => $3::int)`,
    [employeeId, COUNTED_OUTCOMES, RATE_WINDOW_MINUTES],
  );
  return Number(result.rows[0]?.n ?? 0);
}

/**
 * D5: the `mocked` attempts already recorded this TENANT-LOCAL calendar
 * month, plus that month as the DB clock sees it (the dedupe-key suffix
 * must come from the same clock as the count).
 */
export async function countMonthlyMocked(
  tx: PoolClient,
  employeeId: string,
  timezone: string,
): Promise<{ count: number; month: string }> {
  const result = await tx.query<{ n: string; month: string }>(
    `select count(*)::text as n,
            to_char(now() at time zone $2::text, 'YYYY-MM') as month
     from public.attendance_attempts
     where employee_id = $1 and outcome = 'mocked'
       and (attempted_at at time zone $2::text)
             >= date_trunc('month', now() at time zone $2::text)`,
    [employeeId, timezone],
  );
  return {
    count: Number(result.rows[0]?.n ?? 0),
    month: result.rows[0]?.month ?? '',
  };
}

/**
 * Writes the attempt row and returns its id — or NULL when the idempotency
 * UNIQUE (tenant_id, request_id) was raced by a different employee (same-
 * employee racers are serialised by the AD-5 employee lock). Callers map
 * null to the committed DUPLICATE_RESOURCE outcome (spec D15).
 */
export async function insertAttempt(
  tx: PoolClient,
  input: {
    tenantId: string;
    employeeId: string;
    requestId: string;
    kind: AttemptKind;
    outcome: string;
    location: AttemptLocation | null;
    blockedUntil: Date | null;
  },
): Promise<string | null> {
  try {
    const result = await tx.query<{ id: string }>(
      `insert into public.attendance_attempts
         (tenant_id, employee_id, request_id, kind, outcome,
          latitude, longitude, accuracy_m, distance_m, radius_m,
          mocked, provider, fix_age_ms, blocked_until)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       returning id`,
      [
        input.tenantId,
        input.employeeId,
        input.requestId,
        input.kind,
        input.outcome,
        input.location?.latitude ?? null,
        input.location?.longitude ?? null,
        input.location?.accuracyM ?? null,
        input.location?.distanceM ?? null,
        input.location?.radiusM ?? null,
        input.location?.mocked ?? null,
        input.location?.provider ?? null,
        input.location?.fixAgeMs ?? null,
        input.blockedUntil,
      ],
    );
    const id = result.rows[0]?.id;
    if (!id) {
      logger.error('Attempt insert returned no id');
      throw internalError('Failed to record the attempt');
    }
    return id;
  } catch (err) {
    if ((err as { code?: string }).code === '23505') {
      return null;
    }
    throw err;
  }
}

/**
 * D5: the fake-location owner alert. The dedupe key carries tenant +
 * recipient (14-2 convention — the unique index is global on dedupe_key
 * alone), so ON CONFLICT needs the partial index's predicate; a collision
 * is a no-op, never an error. Event and entity strings come from the
 * registry — the source of truth (review nit).
 */
export async function insertFakeLocationAlert(
  tx: PoolClient,
  input: {
    tenantId: string;
    ownerId: string;
    employeeId: string;
    employeeName: string | null;
    month: string;
    attemptCount: number;
    dedupeKey: string;
  },
): Promise<void> {
  await tx.query(
    `insert into public.notifications
       (tenant_id, user_id, job_id, event_type, payload, entity_type, entity_id, dedupe_key)
     values ($1::uuid, $2::uuid, null, $4::text,
             jsonb_build_object('employeeName', $5::text, 'month', $6::text,
                                'attemptCount', $7::int),
             $8::text, $3::uuid, $9::text)
     on conflict (dedupe_key) where dedupe_key is not null do nothing`,
    [
      input.tenantId,
      input.ownerId,
      input.employeeId,
      ATTENDANCE_NOTIFICATION_EVENT.FAKE_LOCATION,
      input.employeeName,
      input.month,
      input.attemptCount,
      ATTENDANCE_ENTITY_TYPE,
      input.dedupeKey,
    ],
  );
}

/** tenants.owner_id — the fake-location alert recipient (3.1 precedent). */
export async function readOwnerId(
  tx: PoolClient,
  tenantId: string,
): Promise<string | null> {
  const result = await tx.query<{ owner_id: string }>(
    'select owner_id from public.tenants where id = $1',
    [tenantId],
  );
  return result.rows[0]?.owner_id ?? null;
}
