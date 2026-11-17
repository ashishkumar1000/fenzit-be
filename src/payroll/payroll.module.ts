import { Module } from '@nestjs/common';
import { SupabaseModule } from '../supabase/supabase.module';
import { PayrollComponentsController } from './payroll-components.controller';
import { PayrollComponentsService } from './payroll-components.service';
import { SalaryStructuresController } from './salary-structures.controller';
import { SalaryStructuresService } from './salary-structures.service';

/**
 * Payroll (epic 23): the salary component library and per-employee salary
 * structures (23-3); the calendar/policy config, deduction heads + statutory
 * engine, run engine, lock, payslips and off-cycle payout land story by
 * story. Table writes through the service client only — no database
 * functions (the zero-RPC boundary). No imports from attendance/ or members/
 * internals: the membership probe is a guarded table read, same as every
 * other module keeps its seams.
 */
@Module({
  imports: [SupabaseModule],
  controllers: [PayrollComponentsController, SalaryStructuresController],
  providers: [PayrollComponentsService, SalaryStructuresService],
})
export class PayrollModule {}
