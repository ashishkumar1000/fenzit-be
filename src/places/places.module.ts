import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PlacesService } from './places.service';
import { PlacesController } from './places.controller';
import { PlacesProvider } from './places-provider';
import { MockPlacesProvider } from './mock-places.provider';
import { GooglePlacesProvider } from './google-places.provider';
import { PlacesRateLimitStore } from './places-rate-limit.store';

// Exported (not inlined in the useFactory below) so the NODE_ENV branch can
// be unit-tested directly without booting the full Nest module.
export function createPlacesProvider(
  configService: ConfigService,
): PlacesProvider {
  return process.env['NODE_ENV'] === 'production'
    ? new GooglePlacesProvider(configService)
    : new MockPlacesProvider(configService);
}

// Deliberately DB-less (AD-2): no SupabaseModule import, no dependency on
// CustomersModule — unlike most other feature modules in this repo.
@Module({
  imports: [],
  controllers: [PlacesController],
  providers: [
    PlacesService,
    PlacesRateLimitStore,
    {
      provide: PlacesProvider,
      // NODE_ENV-conditional so production traffic hits the real Google
      // integration while every other environment (including the
      // Jest-driven e2e suite, where NODE_ENV is never 'production') keeps
      // resolving MockPlacesProvider unchanged.
      useFactory: createPlacesProvider,
      inject: [ConfigService],
    },
  ],
})
export class PlacesModule {}
