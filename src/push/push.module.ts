import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PgModule } from '../common/pg/pg.module';
import { DeviceTokensController } from './device-tokens.controller';
import { DeviceTokensService } from './device-tokens.service';
import { createPushSender } from './push.provider';
import { PushSender } from './push-sender.port';
import { PushSweepService } from './push-sweep.service';

/**
 * Push delivery (CAP-1 + CAP-2): FCM token registration endpoints and the
 * notifications outbox sweep. The provider is chosen once at boot by the
 * async factory (noop by default; fcm requires
 * GOOGLE_APPLICATION_CREDENTIALS or the boot fails — staged rollout, plan
 * §Tasks). The sweep is a plain provider: it arms its own interval only
 * when the resolved sender is not the noop.
 */
@Module({
  imports: [PgModule],
  controllers: [DeviceTokensController],
  providers: [
    {
      provide: PushSender,
      useFactory: createPushSender,
      inject: [ConfigService],
    },
    DeviceTokensService,
    PushSweepService,
  ],
})
export class PushModule {}
