import { Module, Type } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { OtpSessionStore } from './otp-session-store';
import { InMemoryOtpSessionStore } from './in-memory-otp-session.store';
import { SmsDeliveryProvider } from './sms-delivery.provider';
import { MockSmsDeliveryProvider } from './mock-sms-delivery.provider';
import { Msg91SmsDeliveryProvider } from './msg91-sms-delivery.provider';
import { SupabaseModule } from '../supabase/supabase.module';

/**
 * Provider registry (PRD §11 AD-3): adding an SMS provider tomorrow = one
 * adapter file + one entry here + its env vars. Nothing else changes.
 */
const SMS_PROVIDER_REGISTRY: Record<
  string,
  // Both adapters take ConfigService so every registry entry shares one
  // construction shape (the mock ignores it).
  new (configService: ConfigService) => SmsDeliveryProvider
> = {
  mock: MockSmsDeliveryProvider,
  msg91: Msg91SmsDeliveryProvider,
  // twilio: TwilioSmsDeliveryProvider,   // ← tomorrow: 1 line
};

// Exported (not inlined in the useFactory below) so the selection logic can
// be unit-tested directly without booting the full Nest module.
export function createSmsDeliveryProvider(
  configService: ConfigService,
): SmsDeliveryProvider {
  // PRD FR-BE2: tests NEVER burn real SMS (Jest sets NODE_ENV=test); an
  // explicit SMS_DELIVERY_PROVIDER wins otherwise; the fallback is msg91 in
  // production, mock everywhere else (dev stays free until keys are set).
  const key =
    process.env['NODE_ENV'] === 'test'
      ? 'mock'
      : (configService.get<string>('SMS_DELIVERY_PROVIDER') ??
        (process.env['NODE_ENV'] === 'production' ? 'msg91' : 'mock'));
  const Adapter = SMS_PROVIDER_REGISTRY[key];
  if (!Adapter) {
    throw new Error(`Unknown SMS_DELIVERY_PROVIDER: ${key}`);
  }
  // Joi requires the credentials when SMS_DELIVERY_PROVIDER is explicitly
  // msg91 — but production's DEFAULT is also msg91 (above), so an env where
  // the var is merely forgotten must refuse to boot too, not 502 every
  // login at runtime (PRD FR-BE3's principle: bad config = boot error).
  if (
    key === 'msg91' &&
    !configService.get<string>('MSG91_AUTH_KEY')
  ) {
    throw new Error(
      'SMS delivery resolves to msg91 but MSG91_AUTH_KEY is not set — set SMS_DELIVERY_PROVIDER=mock for the pre-SMS window, or provide the MSG91 credentials',
    );
  }
  return new Adapter(configService);
}

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
      provide: SmsDeliveryProvider,
      useFactory: createSmsDeliveryProvider,
      inject: [ConfigService],
    },
  ],
  exports: [AuthService],
})
export class AuthModule {}
