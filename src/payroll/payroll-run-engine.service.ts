import { Injectable, Logger } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import { PgPoolFactory } from '../common/pg/pg-pool.factory';
import { payrollRunAdvisoryKey } from '../common/pg/advisory-keys';
import { SupabaseClientFactory } from '../common/factories/supabase-client.factory';
import { StorageService } from '../storage/storage.service';
import { CALENDAR_DEFAULTS } from './payroll-month-status.service';
import { employeePfCovered, resolvePfCovered } from './pf-config.service';
import { resolveHeadsForMonth } from './deduction-heads.service';
import { pfDeduction, pfWageCeiling } from './statutory';
import { evaluateStructure, moneyText, roundMoney } from './formula';
import type { StoredLine } from './salary-structures.service';
import { computeDayStatus } from '../common/day-status/day-status.model';
import { readDayStatusGrid } from '../common/day-status/grid-reader';
import { isMonthKey } from './effective-dating';
import { capPayable, lopWindow, payableWindow } from './run-window';
import { assembleLop } from './run-lop';
import {
  capClamp,
  earnedLine,
  monthsEmployedInFy,
  tdsProjection,
  type DeductionLine,
} from './run-math';
import { writeAuditRow } from './payroll.helpers';

interface PopulationRow {
  id: string;
  user_id: string;
  join_date: string | null;
  exit_date: string | null;
  employee_code: string;
  pan: string | null;
  father_name: string | null;
  mother_name: string | null;
  spouse_name: string | null;
  designation: string | null;
  department: string | null;
  uan_number: string | null;
  pf_account_number: string | null;
  bank_account_number: string | null;
  ifsc_code: string | null;
  bank_name: string | null;
  employee_name: string;
}

interface StructureRow {
  membership_id: string;
  effective_from: string;
  lines: StoredLine[];
}

interface LibraryRow {
  id: string;
  name: string;
  is_basic: boolean;
}

interface CalendarRow {
  effective_from: string;
  divisor_convention: string;
  cutoff_day: number;
  pay_date: number;
}

interface RecoveryRow {
  id: string;
  membership_id: string;
  month_raised: string;
  outstanding_amount: string;
}

type StatusFact = {
  status: import('../common/day-status/keys').DayStatusKey | null;
  tracked: boolean;
};

interface PayslipInsert {
  membership_id: string;
  user_id: string;
  payable_days: number;
  lop_days: number;
  paid_days: number;
  /** Form V "days worked": present days with half_day as 0.5, over the kept
   *  payable dates (presentation-only — the fixture requires it on the slip
   *  but its buckets never sum to the month). */
  days_worked: number;
  gross_earnings: string;
  pf_employee: string;
  pf_employer: string;
  tds: string;
  other_deductions: string;
  total_deductions: string;
  net_wages: string;
  earning_lines: unknown;
  deduction_lines: unknown;
  warnings: string[];
}

interface MemberFacts {
  employeeName: string | null;
  employeeCode: string | null;
  fatherName: string | null;
  motherName: string | null;
  spouseName: string | null;
  designation: string | null;
  department: string | null;
  pan: string | null;
  uanNumber: string | null;
  bankAccount: string | null;
  ifsc: string | null;
  bankName: string | null;
  joinDate: string | null;
}

interface MonthComputation {
  payslips: PayslipInsert[];
  membershipFacts: Map<string, MemberFacts>;
  summary: Record<string, unknown>;
  recoveryUpdates: Array<{ id: string; outstanding: string }>;
  /** One excess per employee whose deductions breached the cap. */
  excessLines: Array<{ membershipId: string; excess: string }>;
  establishmentName: string | null;
  establishmentAddress: string | null;
  wagePeriodStart: string;
  wagePeriodEnd: string;
  divisorConvention: string;
  cutoffDay: number;
  payDate: number;
}

const FY_START = '2026-04';
const FY_END = '2027-03';

/**
 * The monthly run executor (CAP-3/5): snapshot every month-start-resolved
 * config once, compute each employee's window, LOP (through the shared
 * day-status engine — payroll never recomputes attendance), earnings and
 * deductions, then land everything in ONE transaction: payslips destroy and
 * replace, slip numbers allocate gap-free, recovery lines roll forward, and
 * the run completes — or fails leaving zero payslip changes. Same-month
 * serialization is the pg advisory xact lock, re-checked inside the write
 * transaction; the enqueue side uses the report-claims guarded update.
 */
@Injectable()
export class PayrollRunEngineService {
  private readonly logger = new Logger(PayrollRunEngineService.name);

  constructor(
    private readonly supabaseFactory: SupabaseClientFactory,
    private readonly pg: PgPoolFactory,
    private readonly storageService: StorageService,
  ) {}

  async executeRun(
    runId: string,
    tenantId: string,
    month: string,
  ): Promise<void> {
    const admin = this.supabaseFactory.createAdmin();
    // The initiating owner — captured at claim time below, read by the
    // failure path in the catch too (audit rows need a real user uuid).
    let runActor: string | null = null;
    try {
      // The claim also captures the initiating owner: the run-lifecycle
      // audit rows (write_audit_row) take a real user uuid who is an active
      // member of the tenant — the owner who enqueued the run is that actor.
      const claim = await admin
        .from('payroll_runs')
        .update({ status: 'running', started_at: new Date().toISOString() })
        .eq('id', runId)
        .eq('status', 'queued')
        .select('initiated_by')
        .single<{ initiated_by: string | null }>();
      if (claim.error) {
        throw new Error('the run could not be claimed from the queue');
      }
      runActor = claim.data?.initiated_by ?? null;

      const computed = await this.computeMonth(tenantId, month);

      // 23-8: the payslip rows this run will destroy — read before the write
      // transaction (runs are serialized per tenant+month, so nothing can
      // insert into this month between here and the delete). After the commit
      // these ids locate the payslip PDF requests minted from the destroyed
      // rows, whose stored PDFs the cleanup below deletes.
      const destroyed = await admin
        .from('payroll_payslips')
        .select('id')
        .eq('tenant_id', tenantId)
        .eq('salary_period', month);
      if (destroyed.error) {
        throw new Error('the existing payslips could not be read');
      }
      const destroyedIds = ((destroyed.data ?? []) as Array<{ id: string }>).map(
        (r) => r.id,
      );

      await this.pg.withTransaction(async (tx) => {
        await tx.query(
          `select pg_advisory_xact_lock(hashtextextended($1::text, 0))`,
          [payrollRunAdvisoryKey(tenantId, month)],
        );
        const claim = await tx.query<{ status: string }>(
          `select status from public.payroll_runs where id = $1::uuid for update`,
          [runId],
        );
        if (claim.rows[0]?.status !== 'running') {
          throw new Error('the run was superseded while computing');
        }
        // The lock probe: a lock decided while this run was queued (the
        // enqueue side cannot see it) must fail the run here, inside the
        // write tx, so zero payslip changes land against a final month.
        const locked = await tx.query<{ month: string }>(
          `select month from public.payroll_month_locks
            where tenant_id = $1::uuid and month = $2`,
          [tenantId, month],
        );
        if (locked.rows.length > 0) {
          throw new Error(
            `${month} is locked for payroll — the run cannot replace its payslips`,
          );
        }

        await tx.query(
          `delete from public.payroll_payslips where tenant_id = $1::uuid and salary_period = $2`,
          [tenantId, month],
        );

        for (const payslip of computed.payslips) {
          const seq = await tx.query<{ last_seq: number }>(
            `insert into public.payroll_slip_sequences (tenant_id, salary_period, last_seq)
             values ($1::uuid, $2, 1)
             on conflict (tenant_id, salary_period)
             do update set last_seq = payroll_slip_sequences.last_seq + 1
             returning last_seq`,
            [tenantId, month],
          );
          const slipNumber = `PS-${month}-${String(seq.rows[0].last_seq).padStart(4, '0')}`;
          const facts = computed.membershipFacts.get(payslip.membership_id);
          await tx.query(
            `insert into public.payroll_payslips (
               tenant_id, membership_id, user_id, run_id, salary_period, slip_number,
               employee_name, employee_code, father_name, mother_name, spouse_name,
               designation, department, pan, uan_number, bank_account_number, ifsc_code,
               bank_name, date_of_joining, establishment_name, establishment_address,
               wage_period_start, wage_period_end, divisor_convention, cutoff_day, pay_date,
               payable_days, lop_days, paid_days, days_worked, gross_earnings,
               pf_employee, pf_employer, tds, other_deductions, total_deductions, net_wages,
               earning_lines, deduction_lines, warnings, updated_at)
             values ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,
                     $15,$16,$17,$18,$19::date,$20,$21,$22::date,$23::date,$24,$25,$26,
                     $27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,
                     $38::jsonb,$39::jsonb,$40::jsonb, now())`,
            [
              tenantId,
              payslip.membership_id,
              payslip.user_id,
              runId,
              month,
              slipNumber,
              facts?.employeeName ?? null,
              facts?.employeeCode ?? null,
              facts?.fatherName ?? null,
              facts?.motherName ?? null,
              facts?.spouseName ?? null,
              facts?.designation ?? null,
              facts?.department ?? null,
              facts?.pan ?? null,
              facts?.uanNumber ?? null,
              facts?.bankAccount ?? null,
              facts?.ifsc ?? null,
              facts?.bankName ?? null,
              facts?.joinDate ?? null,
              computed.establishmentName,
              computed.establishmentAddress,
              computed.wagePeriodStart,
              computed.wagePeriodEnd,
              computed.divisorConvention,
              computed.cutoffDay,
              computed.payDate,
              payslip.payable_days,
              payslip.lop_days,
              payslip.paid_days,
              payslip.days_worked,
              payslip.gross_earnings,
              payslip.pf_employee,
              payslip.pf_employer,
              payslip.tds,
              payslip.other_deductions,
              payslip.total_deductions,
              payslip.net_wages,
              JSON.stringify(payslip.earning_lines),
              JSON.stringify(payslip.deduction_lines),
              JSON.stringify(payslip.warnings),
            ],
          );
        }

        for (const recovery of computed.recoveryUpdates) {
          await tx.query(
            `update public.payroll_recovery_lines
                set outstanding_amount = $2, updated_at = now()
              where id = $3::uuid and tenant_id = $1::uuid`,
            [tenantId, recovery.outstanding, recovery.id],
          );
        }
        for (const excess of computed.excessLines) {
          await tx.query(
            `insert into public.payroll_recovery_lines
               (tenant_id, membership_id, month_raised, original_amount, outstanding_amount)
             values ($1::uuid, $2::uuid, $3, $4, $4)`,
            [tenantId, excess.membershipId, month, excess.excess],
          );
        }

        await tx.query(
          `update public.payroll_runs
              set status = 'completed', finished_at = now(), summary = $2::jsonb,
                  updated_at = now()
            where id = $1::uuid`,
          [runId, JSON.stringify(computed.summary)],
        );
      });

      if (destroyedIds.length > 0) {
        await this.deleteSupersededPdfObjects(admin, tenantId, destroyedIds);
      }

      await writeAuditRow(admin, this.logger, 'run', {
        actorId: runActor,
        tenantId,
        action: 'payroll.run_completed',
        targetUser: null,
        details: { month, payslips: computed.payslips.length },
      });
    } catch (e: unknown) {
      const message =
        e instanceof Error ? e.message : 'the run failed for an unknown reason';
      this.logger.error(`Payroll run ${runId} failed: ${message}`);
      await admin
        .from('payroll_runs')
        .update({
          status: 'failed',
          finished_at: new Date().toISOString(),
          error_message: message.slice(0, 500),
          updated_at: new Date().toISOString(),
        })
        .eq('id', runId);
      await writeAuditRow(admin, this.logger, 'run', {
        actorId: runActor,
        tenantId,
        action: 'payroll.run_failed',
        targetUser: null,
        details: { month, reason: message.slice(0, 300) },
      });
      throw e;
    }
  }

  /**
   * 23-8 regeneration semantics (owner decision 2026-11-18): after the
   * destroy-and-replace commits, delete the stored PDFs minted from the
   * destroyed payslip rows — a superseded slip's presigned URL dies with its
   * row instead of surviving on the presign TTL. Runs strictly AFTER the
   * transaction, never inside it: a missed delete degrades to the URL TTL,
   * never to a failed run or a wrong PDF. The payslipId param filter is the
   * discriminator — only payslip requests carry it (range reports don't), so
   * no definition import is needed here. Best-effort end to end: deleteObject
   * never throws, and a read failure only logs.
   */
  private async deleteSupersededPdfObjects(
    admin: SupabaseClient,
    tenantId: string,
    destroyedIds: string[],
  ): Promise<void> {
    try {
      const { data, error } = await admin
        .from('report_requests')
        .select('r2_key')
        .eq('tenant_id', tenantId)
        .in('params->>payslipId', destroyedIds)
        .not('r2_key', 'is', null);
      if (error) {
        this.logger.warn(
          `Superseded payslip PDF lookup failed (URLs degrade to their TTL): ${error.message}`,
        );
        return;
      }
      for (const row of (data ?? []) as Array<{ r2_key: string }>) {
        if (row.r2_key) {
          await this.storageService.deleteObject(row.r2_key);
        }
      }
    } catch (err) {
      this.logger.warn(
        'Superseded payslip PDF cleanup failed (URLs degrade to their TTL)',
        err,
      );
    }
  }

  /** All reads and per-employee computation — no writes, throws on failure. */
  private async computeMonth(
    tenantId: string,
    month: string,
  ): Promise<MonthComputation> {
    const admin = this.supabaseFactory.createAdmin();
    const firstDay = `${month}-01`;

    // -- the config snapshot (month-start resolution, read once) -----------
    const calendarRes = await admin
      .from('payroll_calendar')
      .select('effective_from, divisor_convention, cutoff_day, pay_date')
      .eq('tenant_id', tenantId)
      .order('effective_from', { ascending: true });
    if (calendarRes.error) throw new Error('the calendar could not be loaded');
    const calendarRows = (
      (calendarRes.data ?? []) as unknown as CalendarRow[]
    ).map((r) => ({
      effectiveFrom: r.effective_from,
      divisorConvention: r.divisor_convention,
      cutoffDay: r.cutoff_day,
      payDate: r.pay_date,
    }));
    const resolvedFor = (m: string) =>
      calendarRows
        .filter((r) => r.effectiveFrom <= `${m}-01`)
        .sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? -1 : 1))
        .at(-1);
    const cutoffOf = (m: string): number =>
      isMonthKey(m)
        ? (resolvedFor(m)?.cutoffDay ?? CALENDAR_DEFAULTS.cutoffDay)
        : CALENDAR_DEFAULTS.cutoffDay;
    const resolved = resolvedFor(month);
    const divisorConvention =
      resolved?.divisorConvention ?? CALENDAR_DEFAULTS.divisorConvention;
    const cutoffDay = resolved?.cutoffDay ?? CALENDAR_DEFAULTS.cutoffDay;
    const payDate = resolved?.payDate ?? CALENDAR_DEFAULTS.payDate;
    const divisor =
      divisorConvention === 'calendar'
        ? new Date(
            Number(month.slice(0, 4)),
            Number(month.slice(5, 7)),
            0,
          ).getDate()
        : divisorConvention === 'fixed-30'
          ? 30
          : 26;

    const headsRes = await admin
      .from('payroll_deduction_heads')
      .select('name, kind, amount, basis, effective_from, active')
      .eq('tenant_id', tenantId);
    if (headsRes.error)
      throw new Error('the deduction heads could not be loaded');
    const heads = resolveHeadsForMonth(headsRes.data ?? [], month);

    const pfRes = await admin
      .from('payroll_pf_config')
      .select('effective_from, covered')
      .eq('tenant_id', tenantId)
      .order('effective_from', { ascending: true });
    if (pfRes.error) throw new Error('the PF config could not be loaded');
    const switchCovered = resolvePfCovered(
      ((pfRes.data ?? []) as Array<Record<string, unknown>>).map((r) => ({
        effectiveFrom: String(r['effective_from']),
        covered: r['covered'] === true,
      })),
      month,
    );
    const ceiling = pfWageCeiling(month);

    const populationRes = await admin
      .from('memberships')
      .select(
        `id, user_id, join_date, exit_date, employee_code, pan, father_name,
         mother_name, spouse_name, designation, department, uan_number,
         pf_account_number, bank_account_number, ifsc_code, bank_name,
         users!memberships_user_id_fkey(name)`,
      )
      .eq('tenant_id', tenantId)
      .eq('role', 'employee')
      .eq('status', 'active')
      .order('employee_code', { ascending: true });
    if (populationRes.error) {
      throw new Error('the employee population could not be loaded');
    }
    type PopRaw = Omit<PopulationRow, 'employee_name'> & {
      users: { name: string | null } | null;
    };
    const seen = new Set<string>();
    const population: PopulationRow[] = [];
    for (const raw of (populationRes.data ?? []) as unknown as PopRaw[]) {
      if (seen.has(raw.user_id)) continue; // one person, one payslip
      seen.add(raw.user_id);
      population.push({
        ...raw,
        employee_name: raw.users?.name || `Employee ${raw.employee_code}`,
      });
    }

    const structuresRes = await admin
      .from('salary_structures')
      .select('membership_id, effective_from, lines')
      .eq('tenant_id', tenantId)
      .order('effective_from', { ascending: true });
    if (structuresRes.error) {
      throw new Error('the salary structures could not be loaded');
    }
    const structureRows = (structuresRes.data ??
      []) as unknown as StructureRow[];
    const structureFor = (membershipId: string): StoredLine[] | null => {
      const row = structureRows
        .filter(
          (r) =>
            r.membership_id === membershipId && r.effective_from <= firstDay,
        )
        .sort((a, b) => (a.effective_from < b.effective_from ? -1 : 1))
        .at(-1);
      return row ? row.lines : null;
    };

    const libraryRes = await admin
      .from('salary_components')
      .select('id, name, is_basic')
      .eq('tenant_id', tenantId);
    if (libraryRes.error)
      throw new Error('the component library could not be loaded');
    const library = (libraryRes.data ?? []) as unknown as LibraryRow[];
    const basicId = library.find((c) => c.is_basic)?.id ?? null;
    const nameOf = new Map(library.map((c) => [c.id, c.name]));

    const exclusionsRes = await admin
      .from('payroll_pf_exclusions')
      .select('membership_id, excluded')
      .eq('tenant_id', tenantId);
    if (exclusionsRes.error)
      throw new Error('the PF exclusions could not be loaded');
    const excludedMembers = new Set(
      (
        (exclusionsRes.data ?? []) as Array<{
          membership_id: string;
          excluded: boolean;
        }>
      )
        .filter((r) => r.excluded)
        .map((r) => r.membership_id),
    );

    const tenantRes = await admin
      .from('tenants')
      .select('company_name, address')
      .eq('id', tenantId)
      .maybeSingle<{ company_name: string; address: string | null }>();
    if (tenantRes.error) throw new Error('the company could not be loaded');
    const establishmentName = tenantRes.data?.company_name ?? null;
    const establishmentAddress = tenantRes.data?.address ?? null;

    const overrideRes = await admin
      .from('payroll_run_overrides')
      .select('membership_id, field, amount')
      .eq('tenant_id', tenantId)
      .eq('month', month);
    if (overrideRes.error)
      throw new Error('the run overrides could not be loaded');
    const overrides = new Map<string, number>();
    for (const row of (overrideRes.data ?? []) as Array<{
      membership_id: string;
      field: string;
      amount: string;
    }>) {
      overrides.set(`${row.membership_id}:${row.field}`, Number(row.amount));
    }

    const recoveryRes = await admin
      .from('payroll_recovery_lines')
      .select('id, membership_id, month_raised, outstanding_amount')
      .eq('tenant_id', tenantId)
      .gt('outstanding_amount', 0)
      .order('created_at', { ascending: true });
    if (recoveryRes.error)
      throw new Error('the recovery lines could not be loaded');
    const recoveries = (recoveryRes.data ?? []) as unknown as RecoveryRow[];

    // Prior-FY TDS per user, for the re-spread (the payslips this run is
    // about to destroy-and-replace are THIS month's only; earlier months'
    // rows are the history).
    const priorTdsRes = await admin
      .from('payroll_payslips')
      .select('user_id, tds')
      .eq('tenant_id', tenantId)
      .gte('salary_period', FY_START)
      .lt('salary_period', month);
    if (priorTdsRes.error)
      throw new Error('the prior payslips could not be loaded');
    const priorTdsByUser = new Map<string, number>();
    for (const row of (priorTdsRes.data ?? []) as Array<{
      user_id: string;
      tds: string;
    }>) {
      priorTdsByUser.set(
        row.user_id,
        (priorTdsByUser.get(row.user_id) ?? 0) + Number(row.tds),
      );
    }

    if (population.length === 0) {
      return {
        payslips: [],
        membershipFacts: new Map(),
        summary: {
          month,
          status: 'no_employees',
          employees: 0,
          payslips: 0,
          skips: [],
          warnings: [],
        },
        recoveryUpdates: [],
        excessLines: [],
        establishmentName,
        establishmentAddress,
        wagePeriodStart: firstDay,
        wagePeriodEnd: monthEndOf(month),
        divisorConvention,
        cutoffDay,
        payDate,
      };
    }

    // -- the shared day-status grid (ONE batched read) ----------------------
    // payable = month-only employment days; the LOP window is the OWNED
    // date set (month dates ≤ cut-off + prior month's post-cut-off dates)
    // and can reach outside the payable month (the November row's Oct-27
    // prior-period leave).
    const payableByUser = new Map<string, string[]>();
    const lopByUser = new Map<string, string[]>();
    for (const member of population) {
      if (!member.join_date) continue;
      const employment = {
        joinDate: member.join_date,
        exitDate: member.exit_date,
      };
      payableByUser.set(member.user_id, payableWindow(employment, month));
      lopByUser.set(member.user_id, lopWindow(employment, month, cutoffOf));
    }
    // Empty windows (mid-month joiners in this month) must not poison the
    // range: undefined sorts LAST in a default sort, so at(-1) would hand
    // back undefined and skip the grid entirely.
    const allWindows = [
      ...[...payableByUser.values()],
      ...[...lopByUser.values()],
    ].filter((w) => w.length > 0);
    const gridFrom = allWindows.map((w) => w[0]).sort()[0];
    const gridTo = allWindows
      .map((w) => w.at(-1) as string)
      .sort()
      .at(-1);
    const statusesByUser = new Map<
      string,
      Map<
        string,
        {
          status: import('../common/day-status/keys').DayStatusKey | null;
          tracked: boolean;
        }
      >
    >();
    const overridesByUser = new Map<
      string,
      Map<string, { date: string; status: 'present' | 'half_day' | 'absent' }>
    >();
    const leavesByUser = new Map<
      string,
      Map<string, { unpaid: boolean; half: boolean }>
    >();
    if (gridFrom && gridTo) {
      if (population.length * 62 > 20000) {
        throw new Error('the run population is too large for one pass');
      }
      const userIds = [...payableByUser.keys()];
      const grid = await this.pg.withTransaction((tx) =>
        readDayStatusGrid(tx, tenantId, userIds, gridFrom, gridTo),
      );
      for (const row of grid) {
        const outcome = computeDayStatus({
          ctx: row.ctx,
          record: row.record,
          override: row.override,
          hasUnackMockedAttempt: row.hasUnackMockedAttempt,
          today: row.today,
        });
        const bucket = statusesByUser.get(row.employeeId) ?? new Map();
        bucket.set(row.workDate, {
          status: outcome.status,
          tracked: row.ctx.tracked,
        });
        statusesByUser.set(row.employeeId, bucket);
        if (row.override?.status) {
          const ob = overridesByUser.get(row.employeeId) ?? new Map();
          ob.set(row.workDate, {
            date: row.workDate,
            status: row.override.status as 'present' | 'half_day' | 'absent',
          });
          overridesByUser.set(row.employeeId, ob);
        }
      }
      // The unpaid-typed approved leaves (the catalog's `paid` boolean is
      // resolved at execution time; a NULL type reads as paid).
      const unpaid = await this.pg.withTransaction(async (tx) => {
        const res = await tx.query<{
          employee_id: string;
          leave_date: string;
          part: string;
        }>(
          `select d.employee_id, d.leave_date::text as leave_date, r.part
             from public.leave_request_days d
             join public.leave_requests r on r.id = d.leave_request_id
             join public.leave_types t on t.id = r.leave_type_id
            where d.tenant_id = $1::uuid and d.state = 'approved'
              and t.paid = false
              and d.leave_date between $2 and $3`,
          [tenantId, gridFrom, gridTo],
        );
        return res.rows;
      });
      for (const row of unpaid) {
        const bucket =
          leavesByUser.get(row.employee_id) ??
          new Map<string, { unpaid: boolean; half: boolean }>();
        bucket.set(row.leave_date, {
          unpaid: true,
          half: row.part !== 'full_day',
        });
        leavesByUser.set(row.employee_id, bucket);
      }
    }

    // -- per-employee computation -------------------------------------------
    const payslips: PayslipInsert[] = [];
    const membershipFacts = new Map<string, MemberFacts>();
    const skips: Array<Record<string, string>> = [];
    const warnings: string[] = [];
    const recoveryUpdates: Array<{ id: string; outstanding: string }> = [];
    const excessLines: Array<{ membershipId: string; excess: string }> = [];
    const recoveryByMember = new Map<string, RecoveryRow[]>();
    for (const r of recoveries) {
      const bucket = recoveryByMember.get(r.membership_id) ?? [];
      bucket.push(r);
      recoveryByMember.set(r.membership_id, bucket);
    }

    for (const member of population) {
      membershipFacts.set(member.id, {
        employeeName: member.employee_name,
        employeeCode: member.employee_code,
        fatherName: member.father_name,
        motherName: member.mother_name,
        spouseName: member.spouse_name,
        designation: member.designation,
        department: member.department,
        pan: member.pan,
        uanNumber: member.uan_number,
        bankAccount: member.bank_account_number,
        ifsc: member.ifsc_code,
        bankName: member.bank_name,
        joinDate: member.join_date,
      });

      if (!member.join_date) {
        skips.push({
          employee: member.employee_name,
          reason: 'missing_join_date',
          detail:
            'no joining date on the employment record — set it in the employee profile and run again',
        });
        continue;
      }
      const lines = structureFor(member.id);
      if (!lines) {
        skips.push({
          employee: member.employee_name,
          reason: 'not_configured',
          detail: 'no salary structure is effective for this month',
        });
        continue;
      }
      const payable = payableByUser.get(member.user_id) ?? [];
      if (payable.length === 0) {
        skips.push({
          employee: member.employee_name,
          reason: 'empty_window',
          detail: 'the employment window has no days inside this run',
        });
        continue;
      }
      const memberStatuses: Map<string, StatusFact> =
        statusesByUser.get(member.user_id) ?? new Map<string, StatusFact>();
      const lopDates = lopByUser.get(member.user_id) ?? [];
      const trackedAny = lopDates.some((d) => memberStatuses.get(d)?.tracked);
      if (!trackedAny) {
        skips.push({
          employee: member.employee_name,
          reason: 'never_enrolled',
          detail:
            'no attendance enrolment covers this month — enroll the employee to run payroll for them',
        });
        continue;
      }

      const kept = capPayable(payable, divisor);
      const payableDays = kept.length;
      // Form V "days worked" (presentation-only): present days with
      // half_day as 0.5, counted over the kept payable dates. Weekly offs
      // and leave days contribute 0 — the buckets never sum to the month.
      const daysWorked = roundMoney(
        kept.reduce((sum, date) => {
          const status = memberStatuses.get(date)?.status;
          if (status === 'present') return sum + 1;
          if (status === 'half_day') return sum + 0.5;
          return sum;
        }, 0),
      );
      // LOP attribution is by OWNERSHIP over the uncapped owned-date set —
      // the November row's Oct-27 prior-period leave LOPs even though the
      // date is not payable in November.
      const lop = assembleLop(
        lopDates,
        memberStatuses,
        leavesByUser.get(member.user_id) ??
          new Map<string, { unpaid: boolean; half: boolean }>(),
        overridesByUser.get(member.user_id) ??
          new Map<
            string,
            { date: string; status: 'present' | 'half_day' | 'absent' }
          >(),
      );
      const paid = roundMoney(Math.max(0, payableDays - lop.lopDays));
      const lopShortfall = payableDays - lop.lopDays < 0;

      const lineInputs = lines.map((l) => ({
        componentId: l.componentId,
        name: nameOf.get(l.componentId) ?? 'component',
        amount: l.amount !== undefined ? Number(l.amount) : undefined,
        formula: l.formula,
      }));
      const evaluation = evaluateStructure(lineInputs);
      if (!evaluation.ok) {
        throw new Error(
          `the salary structure for ${member.employee_name} no longer evaluates: ${evaluation.message}`,
        );
      }

      const earningLines = lineInputs.map((l) => ({
        name: l.name,
        amount: earnedLine(
          evaluation.values.get(l.componentId) ?? 0,
          divisor,
          paid,
        ),
      }));
      const gross = roundMoney(
        earningLines.reduce((sum, l) => sum + Number(l.amount), 0),
      );
      const basicValue = basicId ? (evaluation.values.get(basicId) ?? 0) : 0;
      const earnedBasic = Number(earnedLine(basicValue, divisor, paid));
      const structureTotal = lineInputs.reduce(
        (sum, l) => sum + (evaluation.values.get(l.componentId) ?? 0),
        0,
      );

      // -- deductions (each basis clamps at zero before computing) ----------
      const deductionLines: DeductionLine[] = [];
      const payslipWarnings = [...lop.flags];
      if (lopShortfall) {
        payslipWarnings.push(
          'the LOP days exceed the payable days — the net is floored at zero and the shortfall needs an off-cycle correction',
        );
      }

      const everMember = Boolean(member.uan_number || member.pf_account_number);
      const covered = employeePfCovered({
        everMember,
        switchCovered,
        excluded: excludedMembers.has(member.id),
      });
      let pfEmployee = '0.00';
      if (covered && earnedBasic > 0) {
        pfEmployee = pfDeduction(moneyText(earnedBasic), ceiling).employee;
      }
      const pfOverride = overrides.get(`${member.id}:pf_employee`);
      if (pfOverride !== undefined) pfEmployee = moneyText(pfOverride);
      deductionLines.push({
        source: 'pf_employee',
        amount: Number(pfEmployee),
      });

      let tds = tdsProjection({
        monthlyStructure: structureTotal,
        monthsEmployedInFy: monthsEmployedInFy(
          member.join_date,
          member.exit_date,
        ),
        remainingFyMonths: this.fyRemaining(month),
        priorFyTds: priorTdsByUser.get(member.user_id) ?? 0,
      });
      const tdsOverride = overrides.get(`${member.id}:tds`);
      if (tdsOverride !== undefined) tds = moneyText(tdsOverride);
      deductionLines.push({ source: 'tds', amount: Number(tds) });

      for (const head of heads) {
        const basis =
          head.kind === 'percent'
            ? head.basis === 'basic'
              ? earnedBasic
              : gross
            : Number(head.amount);
        const amount =
          head.kind === 'percent'
            ? roundMoney((Number(head.amount) / 100) * basis)
            : basis;
        deductionLines.push({ source: `head:${head.name}`, amount });
      }
      for (const recovery of recoveryByMember.get(member.id) ?? []) {
        deductionLines.push({
          source: `recovery:${recovery.month_raised}`,
          amount: Number(recovery.outstanding_amount),
        });
      }

      const capped = capClamp(deductionLines, gross);
      let recoveryIndex = 0;
      for (const line of capped.lines) {
        if (!line.source.startsWith('recovery:')) continue;
        const recovery = (recoveryByMember.get(member.id) ?? [])[recoveryIndex];
        if (recovery) {
          const outstanding = roundMoney(
            Number(recovery.outstanding_amount) - line.amount,
          );
          recoveryUpdates.push({
            id: recovery.id,
            outstanding: moneyText(Math.max(0, outstanding)),
          });
          recoveryIndex += 1;
        }
      }
      if (capped.excess !== '0.00') {
        excessLines.push({ membershipId: member.id, excess: capped.excess });
        warnings.push(
          `${member.employee_name}: deductions exceeded the 50% cap by ₹${capped.excess} — raised as a recovery on the next run`,
        );
      }

      // The snapshot's statutory columns read the CLAMPED lines so the
      // row, its deduction lines and its totals can never disagree.
      const clampedPf = moneyText(
        capped.lines.find((l) => l.source === 'pf_employee')?.amount ?? 0,
      );
      const clampedTds = moneyText(
        capped.lines.find((l) => l.source === 'tds')?.amount ?? 0,
      );
      const otherDeductions = roundMoney(
        capped.lines
          .filter(
            (l) =>
              l.source.startsWith('head:') || l.source.startsWith('recovery:'),
          )
          .reduce((sum, l) => sum + l.amount, 0),
      );
      payslips.push({
        membership_id: member.id,
        user_id: member.user_id,
        payable_days: payableDays,
        lop_days: lop.lopDays,
        paid_days: paid,
        days_worked: daysWorked,
        gross_earnings: moneyText(gross),
        pf_employee: clampedPf,
        pf_employer: clampedPf,
        tds: clampedTds,
        other_deductions: moneyText(otherDeductions),
        total_deductions: capped.totalDeductions,
        net_wages: capped.netWages,
        earning_lines: earningLines,
        deduction_lines: capped.lines.map((l) => ({
          source: l.source,
          amount: moneyText(l.amount),
        })),
        warnings: payslipWarnings,
      });
      if (lop.noAttendanceDates.length > 0) {
        warnings.push(
          `${member.employee_name}: paid days without attendance data (${lop.noAttendanceDates.join(', ')})`,
        );
      }
      if (lop.checkoutMissingDates.length > 0) {
        warnings.push(
          `${member.employee_name}: checkout missing (${lop.checkoutMissingDates.join(', ')}) — paid pending correction`,
        );
      }
      if (!member.pan) {
        warnings.push(
          `${member.employee_name}: no PAN on the employment record`,
        );
      }
    }

    return {
      payslips,
      membershipFacts,
      summary: {
        month,
        employees: population.length,
        payslips: payslips.length,
        skips,
        warnings,
        divisor: divisorConvention,
        cutoff_day: cutoffDay,
        pay_date: payDate,
      },
      recoveryUpdates,
      excessLines,
      establishmentName,
      establishmentAddress,
      wagePeriodStart: firstDay,
      wagePeriodEnd: monthEndOf(month),
      divisorConvention,
      cutoffDay,
      payDate,
    };
  }

  private fyRemaining(month: string): number {
    if (month >= FY_END) return 1;
    const [y, m] = month.split('-').map(Number);
    const [ey, em] = FY_END.split('-').map(Number);
    return (ey - y) * 12 + (em - m) + 1;
  }
}

function monthEndOf(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}
