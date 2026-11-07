import { Module } from '@nestjs/common';
import { CustomersService } from './customers.service';
import { CustomersController } from './customers.controller';
import { SupabaseModule } from '../supabase/supabase.module';
import { CountryCodesModule } from '../country-codes/country-codes.module';
import { ImportController } from './import/import.controller';
import { ImportValidateService } from './import/import-validate.service';
import { ImportCommitService } from './import/import-commit.service';

@Module({
  imports: [SupabaseModule, CountryCodesModule],
  controllers: [CustomersController, ImportController],
  providers: [CustomersService, ImportValidateService, ImportCommitService],
  exports: [CustomersService],
})
export class CustomersModule {}
