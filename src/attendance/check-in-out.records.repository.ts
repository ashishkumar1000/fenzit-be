import { Logger } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { internalError } from './attendance-rpc.helpers';

/**
 * SQL for the attendance_records half of check-in/out (16-1/16-2) — split
 * from the attempts repository at review to keep both files small. Every
 * function receives the open transaction client; the record exists at most
 * once per (employee_id, work_date) (UNIQUE backstop, AD-6).
 */

const logger = new Logger('CheckInOutRecordsRepository');

export interface RecordRow {
  id: string;
  work_date: string;
  office_id: string;
  office_rules_id: string | null;
  radius_m: number;
  checkin_at: Date | string;
  checkout_at: Date | string | null;
}

export async function findRecordByEmployeeDate(
  tx: PoolClient,
  employeeId: string,
  workDate: string,
): Promise<RecordRow | null> {
  const result = await tx.query<RecordRow>(
    `select id, work_date::text, office_id, office_rules_id::text, radius_m,
            checkin_at, checkout_at
     from public.attendance_records
     where employee_id = $1 and work_date = $2::date`,
    [employeeId, workDate],
  );
  return result.rows[0] ?? null;
}

/** AD-6 replay rebuild: the record an `ok` attempt produced. */
export async function findRecordByAttemptId(
  tx: PoolClient,
  attemptId: string,
): Promise<RecordRow | null> {
  const result = await tx.query<RecordRow>(
    `select id, work_date::text, office_id, office_rules_id::text, radius_m,
            checkin_at, checkout_at
     from public.attendance_records
     where checkin_attempt_id = $1 or checkout_attempt_id = $1`,
    [attemptId],
  );
  return result.rows[0] ?? null;
}

export interface CheckInSnapshot {
  tenantId: string;
  employeeId: string;
  workDate: string;
  officeId: string;
  officeRulesId: string | null;
  radiusM: number;
  attemptId: string;
  latitude: number;
  longitude: number;
  accuracyM: number;
  distanceM: number;
  mocked: boolean;
  provider: string | null;
}

/** The accepted check-in — one INSERT, all AD-9 snapshot columns. */
export async function insertRecord(
  tx: PoolClient,
  s: CheckInSnapshot,
): Promise<void> {
  await tx.query(
    `insert into public.attendance_records
       (tenant_id, employee_id, work_date, office_id, office_rules_id, radius_m,
        checkin_at, checkin_attempt_id, checkin_lat, checkin_lng,
        checkin_accuracy_m, checkin_distance_m, checkin_mocked, checkin_provider)
     values ($1, $2, $3::date, $4, $5, $6, now(), $7, $8, $9, $10, $11, $12, $13)`,
    [
      s.tenantId,
      s.employeeId,
      s.workDate,
      s.officeId,
      s.officeRulesId,
      s.radiusM,
      s.attemptId,
      s.latitude,
      s.longitude,
      s.accuracyM,
      s.distanceM,
      s.mocked,
      s.provider,
    ],
  );
}

export interface CheckOutSnapshot {
  recordId: string;
  attemptId: string;
  latitude: number;
  longitude: number;
  accuracyM: number;
  distanceM: number;
  mocked: boolean;
  provider: string | null;
}

/** The accepted check-out — one guarded UPDATE on the same row (AD-9). */
export async function updateRecordCheckout(
  tx: PoolClient,
  s: CheckOutSnapshot,
): Promise<void> {
  const result = await tx.query(
    `update public.attendance_records
     set checkout_at = now(), checkout_attempt_id = $2, checkout_lat = $3,
         checkout_lng = $4, checkout_accuracy_m = $5, checkout_distance_m = $6,
         checkout_mocked = $7, checkout_provider = $8
     where id = $1 and checkout_at is null`,
    [
      s.recordId,
      s.attemptId,
      s.latitude,
      s.longitude,
      s.accuracyM,
      s.distanceM,
      s.mocked,
      s.provider,
    ],
  );
  if (result.rowCount !== 1) {
    // The pre-check under the employee lock makes this unreachable unless
    // the row moved underneath us — fail loud rather than half-write.
    logger.error('Check-out update matched no open record', { recordId: s.recordId });
    throw internalError('Failed to record check-out');
  }
}
