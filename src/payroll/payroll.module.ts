import { Module } from '@nestjs/common';
import { SupabaseModule } from '../supabase/supabase.module';
import { DeductionHeadsService } from './deduction-heads.service';
import { PayrollComponentsController } from './payroll-components.controller';
import { PayrollComponentsService } from './payroll-components.service';
import { PayrollConfigController } from './payroll-config.controller';
import { PayrollCalendarService } from './payroll-calendar.service';
import { PayrollHeadsController } from './payroll-heads.controller';
import { PayrollMonthStatusService } from './payroll-month-status.service';
import { PayrollStatutoryController } from './payroll-statutory.controller';
import { PayrollStateRulesService } from './payroll-state-rules.service';
import { PayrollPfConfigService } from './pf-config.service';
import { PayrollPfExclusionService } from './pf-exclusion.service';
import { SalaryStructuresController } from './salary-structures.controller';
import { SalaryStructuresService } from './salary-structures.service';

/**
 * Payroll (epic 23): the salary component library, per-employee salary
 * structures (23-3), the calendar/policy config + month-status read (23-4),
 * and the deduction heads + statutory engine (23-5); run engine, lock,
 * payslips and off-cycle payout land story by story. Table writes through
 * the service client only — no database functions (the zero-RPC boundary).
 * No imports from attendance/ or members/ internals: the membership probe is
 * a guarded table read, same as every other module keeps its seams.
 */
@Module({
  imports: [SupabaseModule],
  controllers: [
    PayrollComponentsController,
    SalaryStructuresController,
    PayrollConfigController,
    PayrollHeadsController,
    PayrollStatutoryController,
  ],
  providers: [
    PayrollComponentsService,
    SalaryStructuresService,
    PayrollCalendarService,
    PayrollMonthStatusService,
    PayrollStateRulesService,
    DeductionHeadsService,
    PayrollPfConfigService,
    PayrollPfExclusionService,
  ],
})
export class PayrollModule {}
