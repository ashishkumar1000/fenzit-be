/**
 * The LOP-equivalent assembler (SPEC §Run arithmetic) — pure, no I/O.
 *
 * One LOP source per date, precedence: owner override > approved UNPAID
 * leave > day-status `absent`. Paid-typed leaves contribute zero. Days
 * The run feeds the OWNED date set (month dates ≤ cut-off + the prior
 * month's post-cut-off dates — uncapped, intersected with employment): the
 * November row's Oct-27 prior-period leave LOPs on a date that is not
 * payable in November. checkout_missing and attendance-data gaps inside a
 * partially-tracked window are paid and flagged — never LOP.
 */
import { DayStatusKey } from '../common/day-status/keys';

export interface DayFact {
  date: string;
  status: DayStatusKey | null;
  tracked: boolean;
}

export interface LeaveFact {
  /** The date is the map key; carried for direct-call readability. */
  date?: string;
  unpaid: boolean;
  half: boolean;
}

export interface OverrideFact {
  date: string;
  status: 'present' | 'half_day' | 'absent';
}

export interface LopResult {
  lopDays: number;
  /** Per-date flags for the run summary: checkout_missing / enrolment_gap. */
  flags: string[];
  checkoutMissingDates: string[];
  noAttendanceDates: string[];
}

const HALF = 0.5;

export function assembleLop(
  dates: string[],
  statuses: Map<string, { status: DayStatusKey | null; tracked: boolean }>,
  leaves: Map<string, LeaveFact>,
  overrides: Map<string, OverrideFact>,
): LopResult {
  let lopDays = 0;
  const flags: string[] = [];
  const checkoutMissingDates: string[] = [];
  const noAttendanceDates: string[] = [];

  for (const date of dates) {
    const override = overrides.get(date);
    if (override) {
      // The owner's correction REPLACES the leave-derived treatment.
      if (override.status === 'absent') lopDays += 1;
      else if (override.status === 'half_day') lopDays += HALF;
      continue;
    }
    const leave = leaves.get(date);
    if (leave && leave.unpaid) {
      lopDays += leave.half ? HALF : 1;
      continue;
    }
    // A paid-typed leave covers the day — zero LOP either way.
    if (leave && !leave.unpaid) continue;

    const fact = statuses.get(date);
    const status = fact?.status ?? null;
    if (status === 'checkout_missing') {
      checkoutMissingDates.push(date);
      flags.push(`checkout_missing on ${date} — paid pending owner correction`);
      continue;
    }
    if (status === 'absent') {
      lopDays += 1;
      continue;
    }
    if (fact && !fact.tracked) {
      // No attendance data for a day inside a partially-tracked window:
      // paid pending correction, flagged (the enrolment-gap rule).
      noAttendanceDates.push(date);
      flags.push(`no attendance data on ${date} — paid pending correction`);
      continue;
    }
    // present / weekly_off / holiday / leave / half_day_leave(paid) / …
    continue;
  }

  // Half-day LOPs must never accumulate float drift: snap to one decimal.
  lopDays = Math.round(lopDays * 10) / 10;
  return { lopDays, flags, checkoutMissingDates, noAttendanceDates };
}
