import {
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import {
  resetDbPoolStats,
  setDbPoolStats,
  type DbPoolStats,
} from '../../telemetry/domain-metrics';
import { PgPoolFactory } from './pg-pool.factory';

/**
 * Wires the DB-pool saturation gauges (domain-metrics.ts) to the PgPool —
 * the same binder pattern as attendance's ReminderJobMetricsBinder: the
 * pool cannot be handed to telemetry at boot (telemetry inits before the
 * Nest DI container in main.ts), so this registers a read seam from
 * onModuleInit instead, and the gauge callback resolves the latest
 * registration at each export tick.
 *
 * The seam's read is a plain in-memory pool counter snapshot (no DB round
 * trip), wrapped so a torn-down pool observes nothing rather than throwing
 * into the export batch.
 */
@Injectable()
export class DbPoolMetricsBinder implements OnModuleDestroy {
  constructor(private readonly pg: PgPoolFactory) {}

  onModuleInit(): void {
    setDbPoolStats((): DbPoolStats | null => {
      try {
        return this.pg.stats();
      } catch {
        return null;
      }
    });
  }

  onModuleDestroy(): void {
    // Teardown removes the seam — the gauges observe nothing until the next
    // boot registers a fresh one (initTelemetry's shutdown resets the
    // registry together with this seam, so nothing dangling survives).
    resetDbPoolStats();
  }
}
