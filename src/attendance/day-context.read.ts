import { Logger } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { internalError } from './attendance-rpc.helpers';
import {
  OfficeRuleRow,
  WeeklyOffRow,
  pickRuleForDate,
  pickWeeklyOffDays,
} from './me-summary.model';
import { findActiveLeaveForDate } from './leave.repository';
import {
  assembleDayContext,
  DayContext,
  DayFacts,
  OfficeJoinRow,
} from './day-context';

/**
 * The SQL half of the AD-22 day context (16-1) — the reads behind
 * `buildDayContext`, split from the pure math at review for file size.
 * Every statement is parameterised and runs inside the caller's
 * transaction; the pickers are IMPORTED from me-summary.model.ts so the
 * FR-4 summary and this context can never disagree (the 15-9 drift class).
 */

const logger = new Logger('DayContextRead');

interface EnrolmentRow {
  valid: string;
  enabled_at: Date | string;
}

/**
 * Reads every fact for one employee-date inside the caller's transaction
 * (parameterised statements only) and assembles the context.
 *
 * `hasCheckIn` implements D10: the check-in path passes true — FR-2's
 * carve-out ("unless the Employee checks in today") — while read-side
 * consumers (Epic 18+) pass whether a record exists.
 */
export async function buildDayContext(
  tx: PoolClient,
  tenantId: string,
  employeeId: string,
  workDate: string,
  hasCheckIn: boolean,
): Promise<DayContext> {
  const tenant = await tx.query<{ timezone: string }>(
    'select timezone from public.tenants where id = $1',
    [tenantId],
  );
  const timezone = tenant.rows[0]?.timezone;
  if (!timezone) {
    // attendance_today already resolved, so the tenant exists; a missing
    // row/timezone here means the AD-7 contract broke — fail loud.
    logger.error('Tenant timezone missing', { tenantId });
    throw internalError('Failed to resolve day context');
  }

  const [settings, enrolment, assignment, overrides, defaults, holiday] =
    await Promise.all([
      tx.query<{ enabled: boolean; setup_completed_at: Date | string | null }>(
        'select enabled, setup_completed_at from public.attendance_settings where tenant_id = $1',
        [tenantId],
      ),
      tx.query<EnrolmentRow>(
        `select valid::text, enabled_at from public.attendance_enrolments
         where employee_id = $1 and valid @> $2::date limit 1`,
        [employeeId, workDate],
      ),
      tx.query<OfficeJoinRow>(
        `select a.office_id, o.name as office_name, o.latitude as office_lat,
                o.longitude as office_lng, o.radius_m
         from public.attendance_office_assignments a
         join public.attendance_offices o on o.id = a.office_id
         where a.employee_id = $1 and a.valid @> $2::date limit 1`,
        [employeeId, workDate],
      ),
      tx.query<WeeklyOffRow>(
        `select valid::text, days from public.attendance_weekly_off_overrides
         where employee_id = $1 and valid @> $2::date`,
        [employeeId, workDate],
      ),
      tx.query<WeeklyOffRow>(
        `select valid::text, days from public.attendance_weekly_off_defaults
         where tenant_id = $1 and valid @> $2::date`,
        [tenantId, workDate],
      ),
      tx.query<{ id: string; name: string }>(
        `select id, name from public.holidays
         where tenant_id = $1 and holiday_date = $2::date`,
        [tenantId, workDate],
      ),
    ]);
  // The rule depends on the covering assignment's office, so it reads after.
  // NULL (not '') when no assignment covers — an untyped '' fails uuid
  // conversion and would 500 the not-tracked path (review finding).
  const rules = await tx.query<OfficeRuleRow>(
    `select id, valid::text, start_time::text, end_time::text, late_cutoff_minutes,
            full_day_hours::float8, half_day_hours::float8
     from public.attendance_office_rules
     where office_id = $1::uuid and valid @> $2::date limit 1`,
    [assignment.rows[0]?.office_id ?? null, workDate],
  );

  // The AD-22 leave seam (spec-17 D3): today's active leave row — at most
  // one exists (the partial unique index admits no second pending/approved).
  const leave = await findActiveLeaveForDate(tx, employeeId, workDate);

  const enrolmentRow = enrolment.rows[0] ?? null;
  const settingsRow = settings.rows[0] ?? null;
  const facts: DayFacts = {
    enrolmentCovers: enrolmentRow !== null,
    setupCompleted: settingsRow?.setup_completed_at != null,
    enabled: settingsRow?.enabled === true,
    enabledAt: enrolmentRow ? new Date(enrolmentRow.enabled_at) : null,
    enrolmentStart: enrolmentRow ? parseRangeStart(enrolmentRow.valid) : null,
    rule: pickRuleForDate(rules.rows, workDate),
    weeklyOffDays: pickWeeklyOffDays(overrides.rows, defaults.rows, workDate),
    holidayId: holiday.rows[0]?.id ?? null,
    holidayName: holiday.rows[0]?.name ?? null,
  };
  return assembleDayContext(
    tenantId,
    employeeId,
    workDate,
    timezone,
    facts,
    assignment.rows[0] ?? null,
    hasCheckIn,
    leave
      ? {
          state: leave.state,
          part: leave.part as 'full_day' | 'first_half' | 'second_half',
        }
      : null,
  );
}

function parseRangeStart(valid: string): string {
  const match = /^[(\[]([^,]*),/.exec(valid);
  return match?.[1] ?? '';
}
