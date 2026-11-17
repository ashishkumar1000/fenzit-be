import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { SupabaseClientFactory } from '../common/factories/supabase-client.factory';
import { ErrorCode } from '../common/enums/error-code.enum';
import type { RequestUser } from '../common/interfaces/request-user.interface';
import { internalError, requireTenant } from './payroll.helpers';
import { isMonthKey, resolveEffective } from './effective-dating';
import { PayrollMonthStatusView } from './dto/payroll-calendar.dto';

/** The house default policy when no dated row governs the month. */
export const CALENDAR_DEFAULTS = {
  divisorConvention: 'fixed-26',
  cutoffDay: 25,
  payDate: 1,
} as const;

interface CalendarRow {
  effective_from: string;
  divisor_convention: string;
  cutoff_day: number;
  pay_date: number;
}

interface JoinDateRow {
  join_date: string | null;
}

/**
 * What one run month looks like for payroll (CAP-3's acceptance surface and
 * the run engine's config read): the month-start-resolved calendar row (or
 * the defaults), the lock flag (false while no lock state exists — story 7
 * adds the state), and the first-payroll-month bound derived live from the
 * active employees' earliest join date. A month before the bound — or a
 * company with no join dates yet — is answered with a plain-English reason,
 * never a silent rejection. Zero database functions; explicit tenant filters.
 */
@Injectable()
export class PayrollMonthStatusService {
  private readonly logger = new Logger(PayrollMonthStatusService.name);

  constructor(private readonly supabaseFactory: SupabaseClientFactory) {}

  async monthStatus(
    user: RequestUser,
    month: string,
  ): Promise<PayrollMonthStatusView> {
    const tenantId = requireTenant(user);
    if (!isMonthKey(month)) {
      throw new BadRequestException({
        error_code: ErrorCode.VALIDATION_ERROR,
        message: 'month must be a real month written as YYYY-MM',
      });
    }
    const admin = this.supabaseFactory.createAdmin();

    // The two reads are independent — issue them together: this endpoint is
    // the web UI's per-page-load and the run engine's per-run config read,
    // so the parallel pair halves its wall-clock round-trips.
    const [calendarRead, joinsRead] = await Promise.all([
      admin
        .from('payroll_calendar')
        .select('effective_from, divisor_convention, cutoff_day, pay_date')
        .eq('tenant_id', tenantId)
        .order('effective_from', { ascending: true }),
      // The bound is the DB's minimum join date, not a tenant-wide fetch:
      // one row crosses the wire no matter the headcount.
      admin
        .from('memberships')
        .select('join_date')
        .eq('tenant_id', tenantId)
        .eq('role', 'employee')
        .eq('status', 'active')
        .not('join_date', 'is', null)
        .order('join_date', { ascending: true })
        .limit(1),
    ]);
    if (calendarRead.error) {
      this.logger.error('Failed to read the payroll calendar:', {
        error: calendarRead.error,
      });
      throw internalError('Failed to load the payroll month status');
    }
    if (joinsRead.error) {
      this.logger.error('Failed to read the join dates:', {
        error: joinsRead.error,
      });
      throw internalError('Failed to load the payroll month status');
    }
    // resolveEffective speaks camelCase effectiveFrom — map before resolving.
    const resolved = resolveEffective(
      ((calendarRead.data ?? []) as unknown as CalendarRow[]).map((row) => ({
        effectiveFrom: row.effective_from,
        divisorConvention: row.divisor_convention,
        cutoffDay: row.cutoff_day,
        payDate: row.pay_date,
      })),
      month,
    );
    const earliestJoin = (
      (joinsRead.data ?? []) as unknown as JoinDateRow[]
    )[0];
    const firstPayrollMonth =
      typeof earliestJoin?.join_date === 'string'
        ? earliestJoin.join_date.slice(0, 7)
        : null;

    let notRunnableReason: string | null = null;
    if (firstPayrollMonth === null) {
      notRunnableReason =
        'Nobody has a joining date yet — set join dates in the employee records to start running payroll';
    } else if (month < firstPayrollMonth) {
      notRunnableReason = `The first payroll month is ${firstPayrollMonth} — earlier months have no payroll history`;
    }

    return {
      month,
      divisorConvention: (resolved?.divisorConvention ??
        CALENDAR_DEFAULTS.divisorConvention) as PayrollMonthStatusView['divisorConvention'],
      cutoffDay: resolved?.cutoffDay ?? CALENDAR_DEFAULTS.cutoffDay,
      payDate: resolved?.payDate ?? CALENDAR_DEFAULTS.payDate,
      effectiveFrom: resolved?.effectiveFrom ?? null,
      locked: false, // the lock state arrives with the payroll-lock story.
      firstPayrollMonth,
      notRunnableReason,
    };
  }
}
