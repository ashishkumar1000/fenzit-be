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
  return process.env['NODE_ENV'] !== 'test'
    ? new GooglePlacesProvider(configService)
    : new MockPlacesProvider(configService);
}

// Deliberately DB-less (AD-2): no SupabaseModule import, no dependency on
// CustomersModule — unlike most others feature modules in this repo.
@Module({
  imports: [],
  controllers: [PlacesController],
  providers: [
    PlacesService,
    PlacesRateLimitStore,
    {
      provide: PlacesProvider,
      // NODE_ENV-conditional so only the Jest-driven test/e2e suites
      // (NODE_ENV='test', set in test/jest.env.setup.ts and by Jest itself)
      // resolve the deterministic MockPlacesProvider — every other
      // environment, including local dev, hits the real Google integration.
      useFactory: createPlacesProvider,
      inject: [ConfigService],
    },
  ],
})
export class PlacesModule {}
