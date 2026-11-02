import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { SupabaseModule } from '../supabase/supabase.module';
import { AccountDeletionAdminController } from './account-deletion-admin.controller';
import { AccountDeletionAdminService } from './account-deletion-admin.service';
import { AccountDeletionController } from './account-deletion.controller';
import { AccountDeletionService } from './account-deletion.service';

@Module({
  imports: [AuthModule, SupabaseModule],
  controllers: [AccountDeletionController, AccountDeletionAdminController],
  providers: [AccountDeletionService, AccountDeletionAdminService],
})
export class AccountDeletionModule {}
