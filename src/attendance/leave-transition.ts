import { Logger } from '@nestjs/common';
import type { PoolClient } from 'pg';
import {
  type LeaveCause,
  type LeaveDayState,
  LEAVE_CAUSES,
} from './leave.constants';
import {
  leaveRejectionToException,
  leaveTransitionViolation,
} from './leave.model';
import { ErrorCode } from '../common/enums/error-code.enum';
import { PG_OVERLAP_CONSTRAINT } from './leave.constants';
import { findDaysForDisableSweep } from './leave.repository';
import {
  LEAVE_ENTITY_TYPE,
  ATTENDANCE_NOTIFICATION_EVENT,
} from './notification-events';

/**
 * AD-23's single writer for `leave_request_days` state (17-1..17-4). The
 * spine sketched a SQL `leave_transition_days()`; the AD-3 amendment
 * (2026-09-27, Epics 16-19 NestJS-first) keeps the contract in TypeScript
 * — this module is the ONLY code that creates or changes a leave day
 * state. Every path:
 *   (a) re-takes the AD-5 employee lock (reentrant no-op when held — the
 *       "assert the lock is held" rule becomes self-enforcing);
 *   (b) writes exactly the requested dates — `insertInitialLeaveDays` for
 *       the apply-created rows, `transitionLeaveDays` for state changes,
 *       the latter pinning the SOURCE states in the WHERE and asserting
 *       the rowcount (a raced transition cannot double-fire even though
 *       the guard trigger admits same→same writes);
 *   (c) appends ONE leave_events audit row;
 *   (d) inserts the notification the AD-13 registry maps to the cause
 *       (plain parameterised INSERT, dedupe key per registry shape).
 * Callers must already hold shared-tenant + exclusive-employee locks and
 * must have decided under them (read-decide-act atomicity, spec D2).
 */

const logger = new Logger('LeaveTransition');

type RegistryEvent =
  (typeof ATTENDANCE_NOTIFICATION_EVENT)[keyof typeof ATTENDANCE_NOTIFICATION_EVENT];

/** The registry event per cause (null = no notification for that cause). */
const CAUSE_EVENT: Record<(typeof LEAVE_CAUSES)[number], RegistryEvent | null> =
  {
    apply: ATTENDANCE_NOTIFICATION_EVENT.LEAVE_APPLIED,
    apply_on_behalf: ATTENDANCE_NOTIFICATION_EVENT.LEAVE_APPLIED_ON_BEHALF,
    approve: ATTENDANCE_NOTIFICATION_EVENT.LEAVE_APPROVED,
    reject: ATTENDANCE_NOTIFICATION_EVENT.LEAVE_REJECTED,
    employee_cancel: ATTENDANCE_NOTIFICATION_EVENT.LEAVE_EMPLOYEE_CANCELLED,
    owner_revoke: ATTENDANCE_NOTIFICATION_EVENT.LEAVE_OWNER_REVOKED,
    checkin_auto_cancel:
      ATTENDANCE_NOTIFICATION_EVENT.LEAVE_CHECKIN_AUTO_CANCEL,
    disable: ATTENDANCE_NOTIFICATION_EVENT.LEAVE_CANCELLED_BY_DISABLE,
    removal: null, // FR-28: no notification to the removed technician.
  };

interface TransitionCore {
  tenantId: string;
  employeeId: string;
  /** The idempotency key — goes into the dedupe key and the event trail. */
  requestId: string;
  /** The request row's own id (leave_requests.id). */
  leaveRequestDbId: string;
  cause: LeaveCause;
  /** null = system actor (disable/removal). */
  actorId: string | null;
  reason?: string | null;
  /** Payload + recipient for the registry notification; null = insert none. */
  notification: {
    recipientId: string;
    payload: Record<string, unknown>;
    /** Extra key segment (e.g. the date) after the request id. */
    dedupeSuffix?: string;
  } | null;
}

/**
 * 17-1/17-4 apply path: creates the day rows for the whole span (including
 * off days) in their initial state — `pending` for employee apply, directly
 * `approved` for on-behalf (FR-16) — then the event + notification tail.
 */
export async function insertInitialLeaveDays(
  tx: PoolClient,
  input: TransitionCore & { dates: string[]; initialState: LeaveDayState },
): Promise<void> {
  if (input.dates.length === 0) {
    throw leaveTransitionViolation();
  }
  await tx.query('select public.attendance_lock_employee($1)', [
    input.employeeId,
  ]);
  try {
    await tx.query(
      `insert into public.leave_request_days
         (tenant_id, leave_request_id, employee_id, leave_date, state)
       select $1::uuid, $2::uuid, $3::uuid, d::date, $4::text
       from unnest($5::date[]) as d`,
      [
        input.tenantId,
        input.leaveRequestDbId,
        input.employeeId,
        input.initialState,
        input.dates,
      ],
    );
  } catch (err) {
    // D7's documented backstop: a 23505 from the partial unique index (a
    // raced apply the pre-check missed — Epic-19 cron, manual writers)
    // answers LEAVE_OVERLAP, never a raw 500.
    if (
      (err as { code?: string; constraint?: string }).code === '23505' &&
      (err as { constraint?: string }).constraint === PG_OVERLAP_CONSTRAINT
    ) {
      throw leaveRejectionToException({
        errorCode: ErrorCode.LEAVE_OVERLAP,
        message: 'You already have a leave request covering one of these dates',
      });
    }
    throw err;
  }
  await writeEventAndNotification(tx, input, input.dates);
}

/**
 * The transition path (approve / reject / cancel / revoke /
 * checkin_auto_cancel / disable): updates exactly the requested dates from
 * the pinned source states and asserts the rowcount. Returns the dates
 * actually transitioned, ascending.
 */
export async function transitionLeaveDays(
  tx: PoolClient,
  input: TransitionCore & {
    dates: string[];
    fromStates: LeaveDayState[];
    toState: LeaveDayState;
  },
): Promise<string[]> {
  if (input.dates.length === 0) {
    return [];
  }
  await tx.query('select public.attendance_lock_employee($1)', [
    input.employeeId,
  ]);

  const updated = await tx.query<{ leave_date: string }>(
    `update public.leave_request_days
     set state = $1, updated_at = now()
     where leave_request_id = $2
       and leave_date = any($3::date[])
       and state = any($4::text[])
     returning leave_date::text`,
    [input.toState, input.leaveRequestDbId, input.dates, input.fromStates],
  );
  const transitioned = updated.rows.map((r) => r.leave_date);
  if (transitioned.length !== input.dates.length) {
    // A source row moved between the caller's decide and this write — the
    // world changed under us; abort rather than half-apply.
    logger.error('Leave transition rowcount mismatch', {
      requestId: input.requestId,
      expected: input.dates.length,
      actual: transitioned.length,
    });
    throw leaveTransitionViolation();
  }
  await writeEventAndNotification(tx, input, input.dates);
  return transitioned.sort((a, b) => a.localeCompare(b));
}

/**
 * AD-23's `disable` cause goes live with the leave tables (spec-17 D12):
 * ALL pending days are cancelled (AD-23's "pending" is unqualified; the
 * FR-28 parallel confirms), and approved days from the disable's
 * effective date. Actor NULL (system); the employee is notified per
 * affected request. The 15-7 disableEnrolment flow calls this inside its
 * own transaction — locks are already held in the right order.
 */
export async function cancelLeaveOnDisable(
  tx: PoolClient,
  tenantId: string,
  employeeId: string,
  effectiveFrom: string,
): Promise<number> {
  const sweeps = await findDaysForDisableSweep(
    tx,
    tenantId,
    employeeId,
    effectiveFrom,
  );
  for (const sweep of sweeps) {
    const dates = [...sweep.pending, ...sweep.approved].sort((a, b) =>
      a.localeCompare(b),
    );
    if (dates.length === 0) continue;
    await transitionLeaveDays(tx, {
      tenantId,
      employeeId,
      requestId: sweep.requestKey,
      leaveRequestDbId: sweep.requestId,
      dates,
      fromStates: ['pending', 'approved'],
      toState: 'cancelled',
      cause: 'disable',
      actorId: null,
      reason: null,
      notification: {
        recipientId: employeeId,
        payload: {
          startDate: sweep.startDate,
          endDate: sweep.endDate,
          cancelledDates: dates,
        },
      },
    });
  }
  return sweeps.length;
}

/** (c) + (d): one audit row, then the registry notification when mapped. */ async function writeEventAndNotification(
  tx: PoolClient,
  input: TransitionCore,
  dates: string[],
): Promise<void> {
  await tx.query(
    `insert into public.leave_events
       (tenant_id, leave_request_id, employee_id, cause, actor_id, reason, affected_dates)
     values ($1::uuid, $2::uuid, $3::uuid, $4::text, $5::uuid, $6::text, $7::date[])`,
    [
      input.tenantId,
      input.leaveRequestDbId,
      input.employeeId,
      input.cause,
      input.actorId,
      input.reason ?? null,
      dates,
    ],
  );

  const eventType = CAUSE_EVENT[input.cause];
  if (!eventType || !input.notification) {
    return;
  }
  const dedupeKey = [
    input.tenantId,
    eventType,
    input.notification.recipientId,
    input.requestId,
    input.notification.dedupeSuffix ?? '',
  ]
    .filter((part) => part !== '')
    .join(':');
  await tx.query(
    `insert into public.notifications
       (tenant_id, user_id, job_id, event_type, payload, entity_type, entity_id, dedupe_key)
     values ($1::uuid, $2::uuid, null, $3::text, $4::jsonb, $5::text, $6::uuid, $7::text)
     on conflict (dedupe_key) where dedupe_key is not null do nothing`,
    [
      input.tenantId,
      input.notification.recipientId,
      eventType,
      JSON.stringify(input.notification.payload),
      LEAVE_ENTITY_TYPE,
      // entity_id = the leave request row id (AD-13); the payload is self-contained.
      input.leaveRequestDbId,
      dedupeKey,
    ],
  );
}
