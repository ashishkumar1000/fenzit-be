import { Module } from '@nestjs/common';
import { PgModule } from '../common/pg/pg.module';
import { SupabaseModule } from '../supabase/supabase.module';
import { PayrollRunController } from './payroll-run.controller';
import { PayrollRunEngineService } from './payroll-run-engine.service';
import { PayrollRunOverrideService } from './payroll-run-override.service';
import { PayrollRunService } from './payroll-run.service';
import { DeductionHeadsService } from './deduction-heads.service';
import { PayrollAuditService } from './payroll-audit.service';
import { PayrollComponentsController } from './payroll-components.controller';
import { PayrollComponentsService } from './payroll-components.service';
import { PayrollConfigController } from './payroll-config.controller';
import { PayrollCalendarService } from './payroll-calendar.service';
import { PayrollHeadsController } from './payroll-heads.controller';
import { PayrollLockService } from './payroll-lock.service';
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
 * and the deduction heads + statutory engine (23-5), the monthly run engine
 * (23-6) and the permanent month lock + audit trail read (23-7); payslip
 * surfaces and off-cycle payout land story by story. Table writes through
 * the service client only — no database
 * functions (the zero-RPC boundary). No imports from attendance/ or members/
 * internals: the day-status grid comes from common/day-status (shared), the
 * membership probe is a guarded table read, same as every other module
 * keeps its seams.
 */
@Module({
  imports: [SupabaseModule, PgModule],
  controllers: [
    PayrollComponentsController,
    SalaryStructuresController,
    PayrollConfigController,
    PayrollHeadsController,
    PayrollStatutoryController,
    PayrollRunController,
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
    PayrollRunService,
    PayrollRunEngineService,
    PayrollRunOverrideService,
    PayrollLockService,
    PayrollAuditService,
  ],
})
export class PayrollModule {}
