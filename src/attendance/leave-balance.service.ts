import {
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { PoolClient } from 'pg';
import { SupabaseClientFactory } from '../common/factories/supabase-client.factory';
import { PgPoolFactory } from '../common/pg/pg-pool.factory';
import { ErrorCode } from '../common/enums/error-code.enum';
import type { RequestUser } from '../common/interfaces/request-user.interface';
import { requireTenant, writeAuditRpc } from './attendance-rpc.helpers';
import { tenantToday } from './enrolments.repository';
import { pickWeeklyOffDays } from './me-summary.model';
import { isoWeekdayOf } from '../common/day-status/day-context';
import { roundMoney } from '../payroll/formula';
import {
  consumedForType,
  creditsByTypeYear,
  consumedByTypeFy,
  accruedAnnual,
  accruedMonthly,
  deriveTypeBalance,
  fyOf,
  fyWindow,
  insufficientBalanceMessage,
  partWeight,
  consumedKey,
  walkCarryForward,
  type AccrualTypeConfig,
  type DayDebitRow,
} from './leave-balance.math';
import {
  employeeExistsInTenant,
  readEnrolmentFloor,
  readPageSpanFacts,
  readSpanFacts,
  type PageSpan,
  type SpanDayFacts,
} from './leave.repository';
import type {
  CreditLeaveDto,
  CreditView,
  LeaveBalanceView,
  PayslipLeaveBalance,
} from './dto/leave-balance.dto';

/**
 * The derived leave-balance module (23-13). Every number is computed on
 * read — no scheduler, no year-end routine, no stored balances:
 *   balance(Y) = credits(Y) + accrued(Y, asOf) + carryForward(Y) - consumed(Y)
 * with consumed = (pending + approved) WORKING days weighted by part —
 * future-dated pending days debit immediately, and every freeing path
 * restores the balance on its own because consumption derives from the
 * day rows. The math lives in leave-balance.math.ts; the reads here are
 * plain transaction functions (the leave.repository pattern — the run
 * engine imports them directly), the class only wraps the API surface.
 * Zero new SQL functions — table statements in the caller's transaction.
 *
 * The three balance-mutating paths each hold `attendance_lock_employee`:
 * the apply check runs under the apply path's existing lock, and the
 * re-type + credit paths take it in their own transactions — so a
 * concurrent apply, revoke or offsetting credit can never race a check.
 */

/** The raw catalog row the accrual reads select (numeric days arrive as text). */
interface LeaveTypeDbRow {
  id: string;
  code: string | null;
  name: string;
  accrual_mode: string | null;
  accrual_days: string;
  carry_forward: boolean;
  allow_over_balance: boolean;
  paid: boolean;
  enabled: boolean;
}

const ACCRUAL_TYPE_COLUMNS =
  'id, tenant_id, code, name, accrual_mode, accrual_days::text as accrual_days, carry_forward, allow_over_balance, paid, enabled';

interface TypeWithConfig {
  config: AccrualTypeConfig;
  paid: boolean;
  enabled: boolean;
}

/** Join/exit dates for the accrual (the leaver clamp reads the exit). */
export interface EmploymentFacts {
  joinDate: string;
  exitDate: string | null;
}

interface CreditRow {
  user_id: string;
  leave_type_id: string;
  year: number;
  days: string;
}

/**
 * The derivation for one employee, on the caller's transaction.
 * Returns a row for EVERY accrual-bearing type — enabled and disabled
 * alike (a disabled type's consumed days stay visible); only mode-none
 * types and remnants are excluded.
 */
export async function readBalancesFor(
  tx: PoolClient,
  tenantId: string,
  employeeId: string,
): Promise<LeaveBalanceView[]> {
  const asOf = await tenantToday(tx, tenantId);
  const types = await readAccrualTypes(tx, tenantId, { enabledOnly: false });
  if (types.length === 0) return [];
  const employment = await readEmployment(tx, tenantId, employeeId, asOf);
  const dayRows = await readActiveDayRows(
    tx,
    tenantId,
    [employeeId],
    fyWindow(fyOf(employment.joinDate)).start,
    fyWindow(fyOf(asOf)).end,
    null,
  );
  const credits = creditsByTypeYear(
    await readCreditRows(tx, tenantId, [employeeId]),
  );
  const facts = await factsFor(
    tx,
    tenantId,
    employeeId,
    dayRows.map((r) => r.leave_date),
  );
  const consumed = consumedByTypeFy(
    dayRows,
    facts,
    new Set(types.map((t) => t.config.id)),
  );
  return types.map(({ config, paid, enabled }) => {
    const derived = deriveTypeBalance(
      config,
      employment.joinDate,
      employment.exitDate,
      asOf,
      credits.get(config.id) ?? new Map(),
      consumedForType(consumed, config.id),
    );
    return {
      typeId: config.id,
      code: config.code as string,
      name: config.name,
      accrualMode: config.accrualMode as string,
      accrualDays: config.accrualDays,
      paid,
      enabled,
      ...derived,
    };
  });
}

/**
 * The apply-time check, slotted into applyTransact after the eligibility
 * facts and under the per-employee advisory lock. Each FY segment of the
 * request is checked against ITS OWN balance: the current FY against the
 * full derivation, a future-FY segment against credits only (its prior
 * FY has not completed, so no accrual basis or carry-forward exists yet).
 * A request's off days carry no debit (the same span facts the working
 * count used), halves weigh 0.5, and the comparison runs on rounded
 * values. mode-none types and untyped applies never reach here.
 */
export async function assertBalanceForApply(
  tx: PoolClient,
  tenantId: string,
  employeeId: string,
  type: AccrualTypeConfig,
  dates: string[],
  part: string,
  spanFacts: Map<string, SpanDayFacts>,
  today: string,
): Promise<void> {
  if (!type.accrualMode || type.accrualMode === 'none') return;
  if (type.allowOverBalance) return;
  const needByFy = new Map<number, number>();
  for (const date of dates) {
    if (spanFacts.get(date)?.isWorkingDay !== false) {
      const fy = fyOf(date);
      needByFy.set(fy, roundMoney((needByFy.get(fy) ?? 0) + partWeight(part)));
    }
  }
  if (needByFy.size === 0) return;

  const employment = await readEmployment(tx, tenantId, employeeId, today);
  // The window reaches across the carry-forward chain AND any other-FY
  // segment the request may span (a capped span crosses at most one).
  // dates arrive ascending from the apply's enumerateDates — the max is
  // taken defensively so an unsorted caller can never under-read.
  const windowEnd = laterOf(
    fyWindow(fyOf(today)).end,
    dates.reduce((a, b) => (a > b ? a : b)),
  );
  const dayRows = await readActiveDayRows(
    tx,
    tenantId,
    [employeeId],
    fyWindow(fyOf(employment.joinDate)).start,
    windowEnd,
    null,
  );
  const facts = await factsFor(
    tx,
    tenantId,
    employeeId,
    dayRows.map((r) => r.leave_date),
  );
  const consumed = consumedByTypeFy(dayRows, facts, new Set([type.id]));
  const consumedForThisType = consumedForType(consumed, type.id);
  const credits =
    creditsByTypeYear(await readCreditRows(tx, tenantId, [employeeId])).get(
      type.id,
    ) ?? new Map<number, number>();
  const fy = fyOf(today);
  const { carryForward, unusedByFy } = walkCarryForward(
    type,
    employment.joinDate,
    employment.exitDate,
    fy,
    credits,
    consumedForThisType,
  );
  const isMonthly = type.accrualMode === 'monthly';
  const derivedRemaining = roundMoney(
    roundMoney(credits.get(fy) ?? 0) +
      (isMonthly
        ? accruedMonthly(
            type.accrualDays,
            employment.joinDate,
            fy,
            today,
            employment.exitDate,
          )
        : accruedAnnual(type.accrualDays)) +
      carryForward -
      roundMoney(consumedForThisType.get(fy) ?? 0),
  );
  for (const [segFy, need] of needByFy) {
    // The CURRENT FY checks against the full derivation; a COMPLETED
    // prior FY against its own honest balance (the walk's raw unused —
    // the same figure a backdated day will re-derive the carry-forward
    // from); a FUTURE FY against credits only (no accrual basis or
    // carry-forward exists there yet). A segment before the join FY
    // cannot exist (the apply gates on the join date) and answers 0.
    const available =
      segFy === fy
        ? derivedRemaining
        : segFy < fy
          ? (unusedByFy.get(segFy) ?? 0)
          : roundMoney(
              (credits.get(segFy) ?? 0) -
                (consumed.get(consumedKey(type.id, segFy)) ?? 0),
            );
    if (need > available) {
      throw new UnprocessableEntityException({
        error_code: ErrorCode.LEAVE_INSUFFICIENT_BALANCE,
        message: insufficientBalanceMessage(type.name, available, need),
      });
    }
  }
}

/**
 * The run-time capture for the payslip snapshot: per enabled
 * accrual-bearing type, as of the pay-period's last day — the ONLY
 * date-anchored consumed read in the system (a day after the period
 * end belongs to the next slip). One batched read per fact across the
 * whole population; members without a join date never reach here (the
 * engine skips them upstream).
 */
export async function captureForRun(
  tx: PoolClient,
  tenantId: string,
  employmentByUser: Map<string, EmploymentFacts>,
  monthEnd: string,
): Promise<Map<string, PayslipLeaveBalance[]>> {
  const capture = new Map<string, PayslipLeaveBalance[]>();
  const types = await readAccrualTypes(tx, tenantId, { enabledOnly: true });
  if (types.length === 0 || employmentByUser.size === 0) return capture;
  const userIds = [...employmentByUser.keys()];
  const windowStart = userIds
    .map((id) => fyWindow(fyOf(employmentByUser.get(id)!.joinDate)).start)
    .sort()[0];
  const dayRows = await readActiveDayRows(
    tx,
    tenantId,
    userIds,
    windowStart,
    monthEnd,
    monthEnd,
  );
  const creditRows = await readCreditRows(tx, tenantId, userIds);
  // The page facts read batches the three rule reads across ALL users —
  // the list-page machinery, one implementation, no drift.
  const datesByUser = new Map<string, string[]>();
  for (const row of dayRows) {
    const dates = datesByUser.get(row.employee_id);
    if (dates) dates.push(row.leave_date);
    else datesByUser.set(row.employee_id, [row.leave_date]);
  }
  const spans: PageSpan[] = [...datesByUser].map(([employeeId, dates]) => ({
    employeeId,
    dates: dates.sort(),
  }));
  const factsByUser = await readPageSpanFacts(
    tx,
    tenantId,
    spans,
    pickWeeklyOffDays,
    isoWeekdayOf,
  );
  const typeIds = new Set(types.map((t) => t.config.id));
  for (const [userId, employment] of employmentByUser) {
    const facts = factsByUser.get(userId) ?? new Map<string, SpanDayFacts>();
    const consumed = consumedByTypeFy(
      dayRows.filter((r) => r.employee_id === userId),
      facts,
      typeIds,
    );
    const credits = creditsByTypeYear(
      creditRows.filter((r) => r.user_id === userId),
    );
    capture.set(
      userId,
      types.map(({ config }) => {
        const derived = deriveTypeBalance(
          config,
          employment.joinDate,
          employment.exitDate,
          monthEnd,
          credits.get(config.id) ?? new Map(),
          consumedForType(consumed, config.id),
        );
        return {
          code: config.code as string,
          name: config.name,
          accrued: derived.accrued,
          availed: derived.consumed,
          carryForward: derived.carryForward,
          remaining: derived.remaining,
        };
      }),
    );
  }
  return capture;
}

/** The API surface: the two balance reads and the manual credit write. */
@Injectable()
export class LeaveBalanceService {
  private readonly logger = new Logger(LeaveBalanceService.name);

  constructor(
    private readonly supabaseFactory: SupabaseClientFactory,
    private readonly pg: PgPoolFactory,
  ) {}

  /** GET /attendance/me/leave/balances — own rows, as of the tenant-local today. */
  async readOwnBalances(user: RequestUser): Promise<LeaveBalanceView[]> {
    const tenantId = requireTenant(user);
    return this.pg.withTransaction((tx) =>
      readBalancesFor(tx, tenantId, user.userId),
    );
  }

  /** GET /attendance/leave/:employeeId/balances — any tenant employee's
   *  rows; a foreign or unknown id answers 404 without leaking. */
  async readEmployeeBalances(
    user: RequestUser,
    employeeId: string,
  ): Promise<LeaveBalanceView[]> {
    const tenantId = requireTenant(user);
    return this.pg.withTransaction(async (tx) => {
      if (!(await employeeExistsInTenant(tx, tenantId, employeeId))) {
        throw employeeNotFound();
      }
      return readBalancesFor(tx, tenantId, employeeId);
    });
  }

  /** POST /attendance/leave/credits — one manual credit (or offsetting
   *  correction), under the target's advisory lock so a concurrent
   *  offsetting credit cannot open an over-consumption window. */
  async applyCredit(
    user: RequestUser,
    dto: CreditLeaveDto,
  ): Promise<CreditView> {
    const tenantId = requireTenant(user);
    if (dto.days === 0) {
      throw new UnprocessableEntityException({
        error_code: ErrorCode.VALIDATION_ERROR,
        message:
          'Credit days must not be zero — use a negative credit to correct',
      });
    }
    const admin = this.supabaseFactory.createAdmin();
    const credit = await this.pg.withTransaction(async (tx) => {
      const typeRes = await tx.query<LeaveTypeDbRow>(
        `select ${ACCRUAL_TYPE_COLUMNS}
           from public.leave_types
          where id = $1::uuid and tenant_id = $2::uuid`,
        [dto.leaveTypeId, tenantId],
      );
      const type = typeRes.rows[0];
      if (!type) throw creditTypeNotFound();
      if (!type.accrual_mode || type.accrual_mode === 'none') {
        throw new UnprocessableEntityException({
          error_code: ErrorCode.VALIDATION_ERROR,
          message:
            'This leave type has no accrual balance — credits cannot be applied to it',
        });
      }
      if (!(await employeeExistsInTenant(tx, tenantId, dto.userId))) {
        throw employeeNotFound();
      }
      await tx.query('select public.attendance_lock_employee($1)', [
        dto.userId,
      ]);
      const inserted = await tx.query<{ id: string; created_at: string }>(
        `insert into public.leave_balance_credits
           (tenant_id, user_id, leave_type_id, year, days, source, created_by)
         values ($1::uuid, $2::uuid, $3::uuid, $4, $5::numeric, 'manual', $6::uuid)
         returning id, created_at::text as created_at`,
        [
          tenantId,
          dto.userId,
          dto.leaveTypeId,
          dto.year,
          dto.days,
          user.userId,
        ],
      );
      return inserted.rows[0];
    });
    // Best-effort, post-commit: an audit failure never undoes the credit.
    await this.writeAudit(
      admin,
      user.userId,
      tenantId,
      'leave.credit_created',
      dto.userId,
      { changed_fields: ['days'], days: dto.days, year: dto.year },
    );
    return {
      id: credit.id,
      userId: dto.userId,
      leaveTypeId: dto.leaveTypeId,
      year: dto.year,
      days: dto.days,
      source: 'manual',
      createdAt: credit.created_at,
    };
  }

  /**
   * The audit entry names the figures, never the type names. Best-effort:
   * a failed entry logs and moves on, never undoing the credit.
   */
  private async writeAudit(
    admin: ReturnType<SupabaseClientFactory['createAdmin']>,
    actorId: string,
    tenantId: string,
    action: string,
    targetUserId: string | null,
    details: Record<string, unknown>,
  ): Promise<void> {
    await writeAuditRpc(admin, this.logger, 'leave-balance', {
      actorId,
      tenantId,
      action,
      targetUserId,
      details,
    });
  }
}

// ---------------------------------------------------------------- reads

/** Every accrual-bearing catalog row — remnants (mode NULL) and
 *  mode-none types never join a derivation. */
async function readAccrualTypes(
  tx: PoolClient,
  tenantId: string,
  opts: { enabledOnly: boolean },
): Promise<TypeWithConfig[]> {
  const res = await tx.query<LeaveTypeDbRow>(
    `select ${ACCRUAL_TYPE_COLUMNS}
       from public.leave_types
      where tenant_id = $1::uuid
        and accrual_mode is not null and accrual_mode <> 'none'
        ${opts.enabledOnly ? 'and enabled' : ''}
      order by name asc`,
    [tenantId],
  );
  return res.rows.map((row) => ({
    config: {
      id: row.id,
      code: row.code,
      name: row.name,
      accrualMode: row.accrual_mode as AccrualTypeConfig['accrualMode'],
      accrualDays: Number(row.accrual_days),
      carryForward: row.carry_forward,
      allowOverBalance: row.allow_over_balance,
      enabled: row.enabled,
    },
    paid: row.paid,
    enabled: row.enabled,
  }));
}

/**
 * Join-date resolution: memberships.join_date, else the tracking floor,
 * else the FY start. The 2026-11-17 backfill set every membership's
 * join_date, so the fallbacks are defensive only.
 */
async function readEmployment(
  tx: PoolClient,
  tenantId: string,
  employeeId: string,
  asOf: string,
): Promise<EmploymentFacts> {
  const res = await tx.query<{
    join_date: string | null;
    exit_date: string | null;
  }>(
    `select join_date::text as join_date, exit_date::text as exit_date
       from public.memberships
      where tenant_id = $1::uuid and user_id = $2::uuid`,
    [tenantId, employeeId],
  );
  const row = res.rows[0];
  const exitDate = row?.exit_date ?? null;
  if (row?.join_date) return { joinDate: row.join_date, exitDate };
  const floor = (await readEnrolmentFloor(tx, employeeId, asOf)).floor;
  return { joinDate: floor ?? fyWindow(fyOf(asOf)).start, exitDate };
}

/** Active (pending/approved) day rows of the employees inside the
 *  window, joined to their request's type and part. No leave-date
 *  anchor unless the caller passes one (only the payslip capture does). */
async function readActiveDayRows(
  tx: PoolClient,
  tenantId: string,
  employeeIds: string[],
  windowStart: string,
  windowEnd: string,
  anchorTo: string | null,
): Promise<(DayDebitRow & { employee_id: string })[]> {
  const end = anchorTo && anchorTo < windowEnd ? anchorTo : windowEnd;
  const res = await tx.query<DayDebitRow & { employee_id: string }>(
    `select d.employee_id, d.leave_date::text as leave_date, r.part, r.leave_type_id::text as leave_type_id
       from public.leave_request_days d
       join public.leave_requests r on r.id = d.leave_request_id
      where d.tenant_id = $1::uuid
        and d.employee_id = any($2::uuid[])
        and d.state in ('pending','approved')
        and d.leave_date between $3::date and $4::date`,
    [tenantId, employeeIds, windowStart, end],
  );
  return res.rows;
}

async function readCreditRows(
  tx: PoolClient,
  tenantId: string,
  userIds: string[],
): Promise<CreditRow[]> {
  const res = await tx.query<CreditRow>(
    `select user_id, leave_type_id, year, days::text as days
       from public.leave_balance_credits
      where tenant_id = $1::uuid and user_id = any($2::uuid[])`,
    [tenantId, userIds],
  );
  return res.rows;
}

/** The span facts for the day-row dates (sorted — readSpanFacts takes
 *  the window from the endpoints; an empty list skips the read). */
async function factsFor(
  tx: PoolClient,
  tenantId: string,
  employeeId: string,
  dates: string[],
): Promise<Map<string, SpanDayFacts>> {
  const sorted = [...new Set(dates)].sort();
  if (sorted.length === 0) return new Map();
  return readSpanFacts(
    tx,
    tenantId,
    employeeId,
    sorted,
    pickWeeklyOffDays,
    isoWeekdayOf,
  );
}

function laterOf(a: string, b: string): string {
  return a > b ? a : b;
}

function employeeNotFound(): NotFoundException {
  return new NotFoundException({
    error_code: ErrorCode.RESOURCE_NOT_FOUND,
    message: 'The employee is not in this company',
  });
}

function creditTypeNotFound(): NotFoundException {
  return new NotFoundException({
    error_code: ErrorCode.RESOURCE_NOT_FOUND,
    message: 'The leave type is not in this company',
  });
}
