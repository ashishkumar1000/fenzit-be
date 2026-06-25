import { Module } from '@nestjs/common';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { OtpSessionStore } from './otp-session-store';
import { InMemoryOtpSessionStore } from './in-memory-otp-session.store';
import { OtpDeliveryProvider } from './otp-delivery.provider';
import { MockOtpDeliveryProvider } from './mock-otp-delivery.provider';
import { SupabaseModule } from '../supabase/supabase.module';

@Module({
  imports: [SupabaseModule],
  controllers: [AuthController],
  providers: [
    AuthService,
    {
      provide: OtpSessionStore,
      useClass: InMemoryOtpSessionStore,
    },
    {
      provide: OtpDeliveryProvider,
      useClass: MockOtpDeliveryProvider,
    },
  ],
  exports: [AuthService],
})
export class AuthModule {}
