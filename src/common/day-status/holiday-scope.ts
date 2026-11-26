/**
 * Per-office holiday applicability (console redesign 2026-11-26) — the pure
 * half. Every consumer of `public.holidays` MUST ask applicability through
 * `holidayAppliesToOffice` so the scoped rule can never drift between the
 * day-status engine, the leave span facts and the summary reads.
 */

import { rangeCovers } from './office-rules';

/** DB CHECK admits exactly these (`holidays_scope_check`). */
export const HOLIDAY_SCOPES = ['all', 'offices'] as const;

export type HolidayScope = (typeof HOLIDAY_SCOPES)[number];

/**
 * A holiday row with its office applicability resolved. `officeIds` is the
 * `holiday_offices` join content — always `[]` when scope is 'all'.
 */
export interface ScopedHoliday {
  id: string;
  name: string;
  scope: string;
  officeIds: string[];
}

/**
 * The single applicability rule: an 'all' holiday closes every office; an
 * 'offices' holiday closes only the offices it names. An employee with no
 * covering office is closed by 'all' holidays only — office-less employees
 * never inherit an office-scoped closure (matches the notification fan-out's
 * assignment join).
 */
export function holidayAppliesToOffice(
  holiday: Pick<ScopedHoliday, 'scope' | 'officeIds'> | null | undefined,
  officeId: string | null | undefined,
): boolean {
  if (!holiday) return false;
  if (holiday.scope === 'all') return true;
  return officeId != null && holiday.officeIds.includes(officeId);
}

/**
 * The holidays an employee OBSERVES, keyed by date: a holiday survives when
 * the assignment covering the holiday's DATE has an office its scope covers
 * — one verdict per holiday-date, not one per employee. Assignments are the
 * employee's rows overlapping the span (readAssignmentsOverlapping's shape);
 * no covering assignment means office-less, so only 'all' holidays survive.
 * Batched callers key per employee; the map is theirs to slice.
 */
export function observedHolidaysByDate<
  H extends Pick<ScopedHoliday, 'scope' | 'officeIds'> & { holidayDate: string },
>(holidays: H[], assignments: { officeId: string; valid: string }[]): Map<string, H> {
  const observed = new Map<string, H>();
  for (const holiday of holidays) {
    const covering = assignments.find((a) =>
      rangeCovers(a.valid, holiday.holidayDate),
    );
    if (holidayAppliesToOffice(holiday, covering?.officeId ?? null)) {
      observed.set(holiday.holidayDate, holiday);
    }
  }
  return observed;
}
