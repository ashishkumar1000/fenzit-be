import { Module } from '@nestjs/common';
import { SupabaseModule } from '../supabase/supabase.module';
import { AdminConfigController } from './admin-config.controller';
import { AdminConfigService } from './admin-config.service';
import { AdminTenantValidityController } from './admin-tenant-validity.controller';
import { AdminTenantValidityService } from './admin-tenant-validity.service';

@Module({
  imports: [SupabaseModule],
  controllers: [AdminConfigController, AdminTenantValidityController],
  providers: [AdminConfigService, AdminTenantValidityService],
})
export class AdminConfigModule {}
