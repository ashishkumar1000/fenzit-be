import {
  HttpException,
  HttpStatus,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SupabaseClientFactory } from '../common/factories/supabase-client.factory';
import { StorageService } from '../storage/storage.service';
import { ErrorCode } from '../common/enums/error-code.enum';
import { ReportRequestStatus } from '../reports/enums/report-status.enum';
import { MAX_IN_FLIGHT_REPORTS, PT_IN_FLIGHT_LIMIT } from '../reports/reports.service';
import type { RequestUser } from '../common/interfaces/request-user.interface';
import { isMonthKey } from './effective-dating';
import { PayrollMonthStatusService } from './payroll-month-status.service';
import {
  internalError,
  requireTenant,
  validationError,
} from './payroll.helpers';
import {
  PayslipPdf,
  PayslipPdfRequestView,
  PayslipRow,
  PayslipView,
} from './dto/payroll-payslip.dto';

/**
 * The `payslip` report request's stored params — jsonb containment on the
 * FULL triple joins a request to exactly one payslip row, so a re-run's new
 * payslip (new id) never inherits the destroyed row's stale request.
 */
type PayslipRequestParams = {
  month: string;
  membershipId: string;
  payslipId: string;
};

interface PayslipRequestRow {
  id: string;
  params: PayslipRequestParams | null;
  status: ReportRequestStatus;
  r2_key: string | null;
  created_at: string;
}

const PAYSLIP_COLUMNS = [
  'id',
  'tenant_id',
  'membership_id',
  'user_id',
  'run_id',
  'salary_period',
  'slip_number',
  'employee_name',
  'employee_code',
  'father_name',
  'mother_name',
  'spouse_name',
  'designation',
  'department',
  'pan',
  'uan_number',
  'bank_account_number',
  'ifsc_code',
  'bank_name',
  'date_of_joining',
  'establishment_name',
  'establishment_address',
  'wage_period_start',
  'wage_period_end',
  'divisor_convention',
  'cutoff_day',
  'pay_date',
  'payable_days',
  'lop_days',
  'paid_days',
  'days_worked',
  'gross_earnings',
  'pf_employee',
  'pf_employer',
  'tds',
  'other_deductions',
  'total_deductions',
  'net_wages',
  'earning_lines',
  'deduction_lines',
  'warnings',
  'created_at',
].join(', ');

/** Payslip PDFs queue through `report_requests` (type `payslip`) — the
 *  payroll-side plain insert per the owner decision (23-8): no import of the
 *  reports service, just the shared PT429 SQLSTATE mapping. Employees poll
 *  via their payslip GET (pdf.status/url) — they hold neither `report.read`
 *  nor `report.request`. Zero database functions; every read carries an
 *  explicit tenant filter. */
@Injectable()
export class PayrollPayslipsService {
  private readonly logger = new Logger(PayrollPayslipsService.name);

  constructor(
    private readonly supabaseFactory: SupabaseClientFactory,
    private readonly storageService: StorageService,
    private readonly configService: ConfigService,
    private readonly monthStatusService: PayrollMonthStatusService,
  ) {}

  /** GET /payroll/payslips?month= — the month's snapshot rows, any month
   *  state (the admin previews pre-lock). Cross-tenant → zero rows. */
  async adminList(user: RequestUser, month: string): Promise<PayslipView[]> {
    const tenantId = requireTenant(user);
    if (!isMonthKey(month)) {
      throw validationError('month must be a real month written as YYYY-MM');
    }
    const admin = this.supabaseFactory.createAdmin();
    const { data, error } = await admin
      .from('payroll_payslips')
      .select(PAYSLIP_COLUMNS)
      .eq('tenant_id', tenantId)
      .eq('salary_period', month)
      .order('slip_number', { ascending: true });
    if (error) {
      this.logger.error('Failed to list payslips:', { error });
      throw internalError('Failed to load the payslips');
    }
    const rows = (data ?? []) as unknown as PayslipRow[];
    return this.withPdf(admin, tenantId, rows);
  }

  /** GET /payroll/payslips/me — own history, LOCKED months only (an inner
   *  join against payroll_month_locks: pre-lock rows are filtered, never
   *  leaked), newest month first. */
  async ownHistory(user: RequestUser): Promise<PayslipView[]> {
    const tenantId = requireTenant(user);
    const admin = this.supabaseFactory.createAdmin();
    const { data: locks, error: locksError } = await admin
      .from('payroll_month_locks')
      .select('month')
      .eq('tenant_id', tenantId);
    if (locksError) {
      this.logger.error('Failed to read the month locks:', {
        error: locksError,
      });
      throw internalError('Failed to load your payslips');
    }
    const months = (locks ?? []).map((row) => row.month);
    if (months.length === 0) {
      return [];
    }
    const { data, error } = await admin
      .from('payroll_payslips')
      .select(PAYSLIP_COLUMNS)
      .eq('tenant_id', tenantId)
      .eq('user_id', user.userId)
      .in('salary_period', months)
      .order('salary_period', { ascending: false });
    if (error) {
      this.logger.error('Failed to list own payslips:', { error });
      throw internalError('Failed to load your payslips');
    }
    const rows = (data ?? []) as unknown as PayslipRow[];
    return this.withPdf(admin, tenantId, rows);
  }

  /** GET /payroll/payslips/me/:month — one own payslip of a locked month.
   *  Not run / out of bound / not locked / not yours all answer 404 in plain
   *  English, branched so a future month never says "wait for the lock". */
  async ownPayslip(user: RequestUser, month: string): Promise<PayslipView> {
    const tenantId = requireTenant(user);
    if (!isMonthKey(month)) {
      throw validationError('month must be a real month written as YYYY-MM');
    }
    const admin = this.supabaseFactory.createAdmin();
    const row = await this.ownRowOfLockedMonth(
      admin,
      tenantId,
      user,
      month,
      'payslip',
    );
    return this.withPdf(admin, tenantId, [row]).then((views) => views[0]);
  }

  /** POST /payroll/payslips/:membershipId/:month/pdf — the admin requests a
   *  payslip PDF for any month state (a live payslip row is the only gate;
   *  pre-lock preview is the admin's own surface). */
  async requestPdfFor(
    user: RequestUser,
    membershipId: string,
    month: string,
  ): Promise<PayslipPdfRequestView> {
    const tenantId = requireTenant(user);
    if (!isMonthKey(month)) {
      throw validationError('month must be a real month written as YYYY-MM');
    }
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(membershipId)) {
      throw validationError('membershipId must be a valid employee id');
    }
    const admin = this.supabaseFactory.createAdmin();
    const { data, error } = await admin
      .from('payroll_payslips')
      .select('id, membership_id, salary_period')
      .eq('tenant_id', tenantId)
      .eq('membership_id', membershipId)
      .eq('salary_period', month)
      .maybeSingle<{ id: string; membership_id: string; salary_period: string }>();
    if (error) {
      this.logger.error('Failed to load the payslip for a PDF request:', {
        error,
      });
      throw internalError('Failed to queue the payslip PDF');
    }
    if (!data) {
      throw this.notFound(
        `No payslip exists for this employee in ${month} — run payroll for ${month} first, then request the PDF`,
      );
    }
    return this.insertRequest(admin, tenantId, user, {
      month: data.salary_period,
      membershipId: data.membership_id,
      payslipId: data.id,
    });
  }

  /** POST /payroll/payslips/me/:month/pdf — the employee requests their own
   *  payslip PDF, gated on the month being locked (same branched 404s as the
   *  single-payslip read). */
  async requestPdfOwn(
    user: RequestUser,
    month: string,
  ): Promise<PayslipPdfRequestView> {
    const tenantId = requireTenant(user);
    if (!isMonthKey(month)) {
      throw validationError('month must be a real month written as YYYY-MM');
    }
    const admin = this.supabaseFactory.createAdmin();
    const row = await this.ownRowOfLockedMonth(
      admin,
      tenantId,
      user,
      month,
      'payslip PDF',
    );
    return this.insertRequest(admin, tenantId, user, {
      month: row.salary_period,
      membershipId: row.membership_id,
      payslipId: row.id,
    });
  }

  /**
   * The shared lock gate behind the /me routes: the month must be runnable
   * AND locked, and the caller's own payslip row must exist. Each miss has
   * its own plain-English 404 (branched copy per the plan).
   */
  private async ownRowOfLockedMonth(
    admin: SupabaseClient,
    tenantId: string,
    user: RequestUser,
    month: string,
    noun: string,
  ): Promise<PayslipRow> {
    const status = await this.monthStatusService.monthStatus(user, month);
    if (status.notRunnableReason) {
      // Out of the runnable bound (before the first payroll month, or no
      // join dates yet): the month cannot have been run at all.
      throw this.notFound(`Payroll for ${month} hasn't been run for your company yet`);
    }
    if (!status.locked) {
      throw this.notFound(
        `Your ${month} ${noun} isn't available yet — it will appear once payroll locks the month`,
      );
    }
    const { data, error } = await admin
      .from('payroll_payslips')
      .select(PAYSLIP_COLUMNS)
      .eq('tenant_id', tenantId)
      .eq('user_id', user.userId)
      .eq('salary_period', month)
      .maybeSingle<PayslipRow>();
    if (error) {
      this.logger.error('Failed to read the own payslip:', { error });
      throw internalError('Failed to load your payslip');
    }
    if (!data) {
      // A locked month always completed a run, so this is "you were not in
      // that month's population" — never dressed up as "payroll hasn't run".
      throw this.notFound(`There is no payslip for you in ${month}`);
    }
    return data;
  }

  /** The queued request insert behind both PDF POSTs: dedupe against a still
   *  in-flight request for the SAME payslip (return it instead of burning a
   *  second in-flight slot), plain INSERT otherwise — the in-flight cap is
   *  the declarative PT429 trigger, mapped to 429. A terminal (`failed`)
   *  request never blocks a re-request: the newest row's failure is final
   *  for it, a fresh attempt is a fresh row. */
  private async insertRequest(
    admin: SupabaseClient,
    tenantId: string,
    user: RequestUser,
    params: PayslipRequestParams,
  ): Promise<PayslipPdfRequestView> {
    const existing = await this.newestRequest(admin, tenantId, params);
    if (
      existing &&
      (existing.status === ReportRequestStatus.QUEUED ||
        existing.status === ReportRequestStatus.GENERATING)
    ) {
      return {
        id: existing.id,
        status: existing.status,
        createdAt: existing.created_at,
      };
    }

    const { data, error } = await admin
      .from('report_requests')
      .insert({
        tenant_id: tenantId,
        requested_by: user.userId,
        report_type: 'payslip',
        params,
      })
      .select('*')
      .single<PayslipRequestRow>();
    if (error) {
      if (error.code === PT_IN_FLIGHT_LIMIT) {
        throw new HttpException(
          {
            error_code: ErrorCode.REPORT_IN_FLIGHT_LIMIT,
            message: `Too many reports in progress — wait for one to finish (max ${MAX_IN_FLIGHT_REPORTS})`,
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      this.logger.error('Failed to queue the payslip PDF request:', { error });
      throw internalError('Failed to queue the payslip PDF');
    }
    return { id: data.id, status: data.status, createdAt: data.created_at };
  }

  /** Newest request matching the FULL params triple — PostgREST jsonb
   *  containment, `created_at desc, id desc` (the id tiebreaker against
   *  same-instant rows), limit 1. No match → null (pdf status `none`). */
  private async newestRequest(
    admin: SupabaseClient,
    tenantId: string,
    params: PayslipRequestParams,
  ): Promise<PayslipRequestRow | null> {
    const { data, error } = await admin
      .from('report_requests')
      .select('id, params, status, r2_key, created_at')
      .eq('tenant_id', tenantId)
      .eq('report_type', 'payslip')
      .contains('params', params)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(1)
      .maybeSingle<PayslipRequestRow>();
    if (error) {
      this.logger.error('Failed to read the payslip PDF request state:', {
        error,
      });
      throw internalError('Failed to load the payslip PDF state');
    }
    return data;
  }

  /**
   * One payslip-request read per LIST (not per row): all payslip-type
   * requests pointing at the LISTED rows (by payslipId, not by month — a
   * month's full request history grows without bound and a windowed read
   * would silently degrade old rows to pdf 'none'), newest first, and the
   * FIRST request seen per payslipId (in that order) is that payslip's
   * newest. Presigning uses the no-HEAD variant — a ready row was stamped
   * only after a successful upload, so the object exists by construction; a
   * 25-row list must not pay 25 sequential R2 HEADs. A presign failure
   * leaves the URL absent, never fails the row.
   */
  private async withPdf(
    admin: SupabaseClient,
    tenantId: string,
    rows: PayslipRow[],
  ): Promise<PayslipView[]> {
    const byPayslip = new Map<string, PayslipRequestRow>();
    if (rows.length > 0) {
      const { data, error } = await admin
        .from('report_requests')
        .select('id, params, status, r2_key, created_at')
        .eq('tenant_id', tenantId)
        .eq('report_type', 'payslip')
        .in('params->>payslipId', rows.map((row) => row.id))
        .order('created_at', { ascending: false })
        .order('id', { ascending: false });
      if (error) {
        this.logger.error('Failed to read the payslip PDF states:', { error });
        throw internalError('Failed to load the payslips');
      }
      for (const row of (data ?? []) as unknown as PayslipRequestRow[]) {
        const payslipId = row.params?.payslipId;
        if (payslipId && !byPayslip.has(payslipId)) {
          byPayslip.set(payslipId, row);
        }
      }
    }
    return Promise.all(
      rows.map((row) => this.toView(row, byPayslip.get(row.id) ?? null)),
    );
  }

  private async toView(
    row: PayslipRow,
    request: PayslipRequestRow | null,
  ): Promise<PayslipView> {
    return {
      id: row.id,
      membershipId: row.membership_id,
      runId: row.run_id,
      month: row.salary_period,
      slipNumber: row.slip_number,
      employeeName: row.employee_name,
      employeeCode: row.employee_code,
      fatherName: row.father_name,
      motherName: row.mother_name,
      spouseName: row.spouse_name,
      designation: row.designation,
      department: row.department,
      pan: row.pan,
      uanNumber: row.uan_number,
      bankAccountNumber: row.bank_account_number,
      ifscCode: row.ifsc_code,
      bankName: row.bank_name,
      dateOfJoining: row.date_of_joining,
      establishmentName: row.establishment_name,
      establishmentAddress: row.establishment_address,
      wagePeriodStart: row.wage_period_start,
      wagePeriodEnd: row.wage_period_end,
      divisorConvention: row.divisor_convention,
      cutoffDay: row.cutoff_day,
      payDate: row.pay_date,
      payableDays: Number(row.payable_days),
      lopDays: Number(row.lop_days),
      paidDays: Number(row.paid_days),
      daysWorked: row.days_worked === null ? null : Number(row.days_worked),
      grossEarnings: Number(row.gross_earnings),
      pfEmployee: Number(row.pf_employee),
      pfEmployer: Number(row.pf_employer),
      tds: Number(row.tds),
      otherDeductions: Number(row.other_deductions),
      totalDeductions: Number(row.total_deductions),
      netWages: Number(row.net_wages),
      earningLines: (row.earning_lines ?? []).map((line) => ({
        name: line.name,
        amount: Number(line.amount),
      })),
      deductionLines: (row.deduction_lines ?? []).map((line) => ({
        source: line.source,
        amount: Number(line.amount),
      })),
      warnings: row.warnings ?? [],
      createdAt: row.created_at,
      pdf: await this.pdfOf(request),
    };
  }

  /** The four DB statuses to the five FE statuses; presign only on ready. */
  private async pdfOf(request: PayslipRequestRow | null): Promise<PayslipPdf> {
    if (!request) {
      return { status: 'none' };
    }
    switch (request.status) {
      case ReportRequestStatus.QUEUED:
        return { status: 'queued' };
      case ReportRequestStatus.GENERATING:
        return { status: 'running' };
      case ReportRequestStatus.FAILED:
        return { status: 'failed' };
      case ReportRequestStatus.READY:
        break;
      default:
        return { status: 'none' };
    }
    if (!request.r2_key) {
      // Cannot happen (ready implies an uploaded object) — but never hang a
      // URL guess on it.
      return { status: 'ready' };
    }
    const ttl =
      this.configService.get<number>('REPORT_PRESIGN_TTL_SECONDS') ?? 600;
    try {
      return {
        status: 'ready',
        url: await this.storageService.presignReadUrl(request.r2_key, ttl),
      };
    } catch (err) {
      this.logger.error('Failed to presign a payslip PDF:', { err });
      return { status: 'ready' };
    }
  }

  private notFound(message: string): NotFoundException {
    return new NotFoundException({
      error_code: ErrorCode.RESOURCE_NOT_FOUND,
      message,
    });
  }
}
