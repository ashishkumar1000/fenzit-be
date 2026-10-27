import { Module } from '@nestjs/common';
import { PgModule } from '../common/pg/pg.module';
import { SupabaseModule } from '../supabase/supabase.module';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';

@Module({
  imports: [PgModule, SupabaseModule],
  controllers: [AdminController],
  providers: [AdminService],
})
export class AdminModule {}
