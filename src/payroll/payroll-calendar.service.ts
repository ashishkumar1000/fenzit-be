import { Injectable, Logger } from '@nestjs/common';
import { SupabaseClientFactory } from '../common/factories/supabase-client.factory';
import type { RequestUser } from '../common/interfaces/request-user.interface';
import {
  internalError,
  requireTenant,
  validationError,
  writeAuditRow,
} from './payroll.helpers';
import {
  DIVISOR_CONVENTIONS,
  DivisorConvention,
  PayrollCalendarView,
  PutPayrollCalendarDto,
} from './dto/payroll-calendar.dto';

interface CalendarRow {
  effective_from: string;
  divisor_convention: string;
  cutoff_day: number;
  pay_date: number;
  created_at: string;
  updated_at: string;
}

const CALENDAR_COLUMNS =
  'effective_from, divisor_convention, cutoff_day, pay_date, created_at, updated_at';

function toCalendarView(row: CalendarRow): PayrollCalendarView {
  return {
    effectiveFrom: row.effective_from,
    divisorConvention: row.divisor_convention as DivisorConvention,
    cutoffDay: row.cutoff_day,
    payDate: row.pay_date,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * The effective-dated payroll calendar (CAP-4, CAP-8): LOP divisor
 * convention, attendance cut-off day and pay date, resolved per month-start
 * by the month-status API and the run engine. A same-date save REPLACES the
 * dated row (the structures idiom); an identical re-save writes nothing and
 * audits nothing. Validation happens here so the rejections can name WHY:
 * the February reason for cut-offs beyond the 28th and the CoW s.17 reason
 * for pay dates beyond the 7th. Zero database functions.
 */
@Injectable()
export class PayrollCalendarService {
  private readonly logger = new Logger(PayrollCalendarService.name);

  constructor(private readonly supabaseFactory: SupabaseClientFactory) {}

  /** The company's dated revisions, oldest first. */
  async list(user: RequestUser): Promise<PayrollCalendarView[]> {
    const tenantId = requireTenant(user);
    const { data, error } = await this.supabaseFactory
      .createAdmin()
      .from('payroll_calendar')
      .select(CALENDAR_COLUMNS)
      .eq('tenant_id', tenantId)
      .order('effective_from', { ascending: true });
    if (error) {
      this.logger.error('Failed to list the payroll calendar:', { error });
      throw internalError('Failed to load the payroll calendar');
    }
    return ((data ?? []) as unknown as CalendarRow[]).map(toCalendarView);
  }

  async save(
    user: RequestUser,
    dto: PutPayrollCalendarDto,
  ): Promise<PayrollCalendarView> {
    const tenantId = requireTenant(user);
    const admin = this.supabaseFactory.createAdmin();

    // No clear verb: an absent field keeps the default for that revision,
    // an explicit null is a refused edit.
    if (
      dto.divisorConvention === null ||
      dto.cutoffDay === null ||
      dto.payDate === null
    ) {
      throw validationError(
        'calendar fields cannot be cleared — omit a field to keep its default',
      );
    }
    if (
      dto.divisorConvention !== undefined &&
      !DIVISOR_CONVENTIONS.includes(dto.divisorConvention as DivisorConvention)
    ) {
      throw validationError(
        `divisorConvention must be one of ${DIVISOR_CONVENTIONS.join(', ')}`,
      );
    }
    if (
      dto.cutoffDay !== undefined &&
      (dto.cutoffDay < 1 || dto.cutoffDay > 28)
    ) {
      throw validationError(
        'cutoffDay must be between 1 and 28 — months have fewer days than 29, so a cut-off of 29/30/31 would skip February entirely',
      );
    }
    if (dto.payDate !== undefined && (dto.payDate < 1 || dto.payDate > 7)) {
      throw validationError(
        'payDate must be between 1 and 7 — the Code on Wages requires wages payable before expiry of the 7th day of the following month, so the 8th onward is a breach',
      );
    }

    const stored = {
      effectiveFrom: dto.effectiveFrom,
      divisorConvention: dto.divisorConvention ?? 'fixed-26',
      cutoffDay: dto.cutoffDay ?? 25,
      payDate: dto.payDate ?? 1,
    };

    // The existence probe decides no-op vs write; a failed probe must not
    // silently turn an identical re-save into a write (phantom audit trail).
    const { data: existing, error: existingError } = await admin
      .from('payroll_calendar')
      .select(CALENDAR_COLUMNS)
      .eq('tenant_id', tenantId)
      .eq('effective_from', dto.effectiveFrom)
      .maybeSingle<CalendarRow>();
    if (existingError) {
      this.logger.error('Failed to read the existing calendar revision:', {
        error: existingError,
      });
      throw internalError('Failed to save the payroll calendar');
    }
    if (
      existing &&
      existing.divisor_convention === stored.divisorConvention &&
      existing.cutoff_day === stored.cutoffDay &&
      existing.pay_date === stored.payDate
    ) {
      return toCalendarView(existing);
    }

    const { data: row, error } = await admin
      .from('payroll_calendar')
      .upsert(
        {
          tenant_id: tenantId,
          effective_from: dto.effectiveFrom,
          divisor_convention: stored.divisorConvention,
          cutoff_day: stored.cutoffDay,
          pay_date: stored.payDate,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'tenant_id,effective_from' },
      )
      .select(CALENDAR_COLUMNS)
      .single<CalendarRow>();
    if (error) {
      this.logger.error('Failed to save the payroll calendar:', { error });
      throw internalError('Failed to save the payroll calendar');
    }

    await writeAuditRow(admin, this.logger, 'calendar', {
      actorId: user.userId,
      tenantId,
      action: 'payroll.calendar_saved',
      targetUser: null,
      details: {
        effective_from: dto.effectiveFrom,
        divisor_convention: stored.divisorConvention,
        cutoff_day: stored.cutoffDay,
        pay_date: stored.payDate,
        ...(existing
          ? {
              previous: {
                divisor_convention: existing.divisor_convention,
                cutoff_day: existing.cutoff_day,
                pay_date: existing.pay_date,
              },
            }
          : {}),
      },
    });
    return toCalendarView(row);
  }
}
