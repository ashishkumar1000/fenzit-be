import { Module } from '@nestjs/common';
import { SupabaseModule } from '../supabase/supabase.module';
import { MembersController } from './members.controller';
import { MembersService } from './members.service';

@Module({
  imports: [SupabaseModule],
  controllers: [MembersController],
  providers: [MembersService],
})
export class MembersModule {}
