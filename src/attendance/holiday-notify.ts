import type { PoolClient } from 'pg';
import {
  ATTENDANCE_ENTITY_TYPE,
  ATTENDANCE_NOTIFICATION_EVENT,
} from './notification-events';
import type { ScopedHoliday } from '../common/day-status/holiday-scope';

/**
 * The holiday notification fan-out in TS (console redesign 2026-11-26) —
 * replaces the legacy `attendance_add_holiday` / `attendance_remove_holiday`
 * RPC branch-for-branch, minus the PL/pgSQL:
 *
 * - recipients = enrolled ∧ office-assigned with the assignment COVERING THE
 *   HOLIDAY DATE ∧ office not archived (INNER-JOIN semantics identical to
 *   the RPC; office-less enrolled employees get nothing — unchanged, and
 *   scope='offices' narrows to the named offices);
 * - future dates only (past holidays are silent — statuses recompute on
 *   read, AD-10);
 * - gated on attendance_settings (setup completed AND enabled);
 * - outbox rows into public.notifications — the push sweep claims them —
 *   deduped by the recipient-prefixed key the partial unique index mandates,
 *   so a retry inserts nothing extra; the key carries the holiday DATE, so a
 *   moved holiday re-notifies instead of being swallowed by the old key.
 */

export interface HolidayFanoutInput {
  tenantId: string;
  holidayId: string;
  holidayName: string;
  /** YYYY-MM-DD — the holiday date, NOT today. */
  holidayDate: string;
  holiday: Pick<ScopedHoliday, 'scope' | 'officeIds'>;
}

/** Whether the tenant's attendance settings allow notification fan-out. */
async function fanoutEnabled(
  tx: PoolClient,
  tenantId: string,
): Promise<boolean> {
  const { rows } = await tx.query<{ allowed: boolean }>(
    `select exists (
       select 1 from public.attendance_settings
       where tenant_id = $1::uuid
         and setup_completed_at is not null
         and enabled
     ) as allowed`,
    [tenantId],
  );
  return rows[0]?.allowed === true;
}

/**
 * One `attendance.holiday_added` / `attendance.holiday_removed` row per
 * recipient, scoped to the holiday's offices when scope is 'offices'.
 * Silent no-op for past dates or when the settings gate is off.
 */
export async function fanoutHolidayNotification(
  tx: PoolClient,
  event:
    | typeof ATTENDANCE_NOTIFICATION_EVENT.HOLIDAY_ADDED
    | typeof ATTENDANCE_NOTIFICATION_EVENT.HOLIDAY_REMOVED,
  input: HolidayFanoutInput,
  tenantToday: string,
): Promise<void> {
  if (input.holidayDate <= tenantToday) return;
  if (!(await fanoutEnabled(tx, input.tenantId))) return;

  const scopeAll = input.holiday.scope === 'all';
  const officeList =
    !scopeAll && input.holiday.officeIds.length > 0
      ? input.holiday.officeIds
      : null;

  await tx.query(
    `insert into public.notifications
       (tenant_id, user_id, job_id, event_type, payload,
        entity_type, entity_id, dedupe_key)
     select $1::uuid,
            e.employee_id,
            null,
            $2::text,
            jsonb_build_object('holidayName', $3::text, 'holidayDate', $4::text),
            $5::text,
            $6::uuid,
            $1::text || ':' || $2::text || ':' || e.employee_id::text || ':' || $6::text || ':' || $4::text
     from public.attendance_enrolments e
     join public.attendance_office_assignments a
       on a.employee_id = e.employee_id
      and a.valid @> $4::date
     join public.attendance_offices o
       on o.id = a.office_id and o.archived_at is null
     where e.tenant_id = $1::uuid
       and e.valid @> $4::date
       and ($7 or a.office_id::text = any($8::text[]))
     on conflict (dedupe_key) where dedupe_key is not null do nothing`,
    [
      input.tenantId,
      event,
      input.holidayName,
      input.holidayDate,
      ATTENDANCE_ENTITY_TYPE,
      input.holidayId,
      // Fail-closed: scope 'offices' with an empty list notifies NOBODY (the
      // `= any('{}')` predicate matches no assignment row), never everybody.
      scopeAll,
      officeList ?? [],
    ],
  );
}
