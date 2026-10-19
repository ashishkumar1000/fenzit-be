import { Module } from '@nestjs/common';
import { SupabaseModule } from '../supabase/supabase.module';
import { CountryCodesController } from './country-codes.controller';
import { CountryCodesService } from './country-codes.service';

@Module({
  imports: [SupabaseModule],
  controllers: [CountryCodesController],
  providers: [CountryCodesService],
})
export class CountryCodesModule {}
