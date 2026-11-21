import { Module } from '@nestjs/common';
import { PgModule } from '../common/pg/pg.module';
import { SupabaseModule } from '../supabase/supabase.module';
import { StorageModule } from '../storage/storage.module';
import { MembersController } from './members.controller';
import { MembersService } from './members.service';

@Module({
  imports: [SupabaseModule, PgModule, StorageModule],
  controllers: [MembersController],
  providers: [MembersService],
})
export class MembersModule {}
