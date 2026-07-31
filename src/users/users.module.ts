import { Module } from '@nestjs/common';
import { UsersService } from './users.service';
import { UsersController } from './users.controller';
import { SupabaseModule } from '../supabase/supabase.module';
import { CustomersModule } from '../customers/customers.module';
import { JobsModule } from '../jobs/jobs.module';

@Module({
  imports: [SupabaseModule, CustomersModule, JobsModule],
  controllers: [UsersController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
