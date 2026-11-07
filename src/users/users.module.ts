import { Module } from '@nestjs/common';
import { UsersService } from './users.service';
import { UsersController } from './users.controller';
import { AvatarService } from './avatar.service';
import { SupabaseModule } from '../supabase/supabase.module';
import { StorageModule } from '../storage/storage.module';
import { CustomersModule } from '../customers/customers.module';
import { JobsModule } from '../jobs/jobs.module';

@Module({
  imports: [SupabaseModule, StorageModule, CustomersModule, JobsModule],
  controllers: [UsersController],
  providers: [UsersService, AvatarService],
  exports: [UsersService],
})
export class UsersModule {}
