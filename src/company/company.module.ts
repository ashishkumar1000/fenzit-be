import { Module } from '@nestjs/common';
import { SupabaseModule } from '../supabase/supabase.module';
import { CompanyService } from './company.service';
import {
  BusinessTypesController,
  CompanyController,
} from './company.controller';

@Module({
  imports: [SupabaseModule],
  controllers: [CompanyController, BusinessTypesController],
  providers: [CompanyService],
  exports: [CompanyService],
})
export class CompanyModule {}
