import { Module } from '@nestjs/common';
import { PlacesService } from './places.service';
import { PlacesController } from './places.controller';
import { PlacesProvider } from './places-provider';
import { MockPlacesProvider } from './mock-places.provider';
import { PlacesRateLimitStore } from './places-rate-limit.store';

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
      useClass: MockPlacesProvider,
    },
  ],
})
export class PlacesModule {}
