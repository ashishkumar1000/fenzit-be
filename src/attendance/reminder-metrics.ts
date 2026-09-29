import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PgPoolFactory } from '../common/pg/pg-pool.factory';
import {
  resetReminderJobMetricQuery,
  setReminderJobMetricQuery,
  type ReminderJobSample,
} from '../telemetry/app-metrics';

/**
 * NFR-9 (19-1): wires the reminder-job ObservableGauges (app-metrics.ts) to
 * the attendance module's pg pool. Telemetry boots before the DI container
 * (telemetry init runs in main.ts), so the gauges cannot take the pool as a
 * constructor argument — this small binder registers the read seam from
 * onModuleInit instead, and the gauge callback resolves the latest
 * registration at each export tick (order-independent by construction).
 *
 * The gauges read pg_cron's own `cron.job_run_details` — a read-only,
 * single-row SELECT that rides this module's regular withTransaction seam
 * (BEGIN → 10 s statement timeout → COMMIT), so it can never balloon and
 * never touch tenant data beyond pg_cron's metadata.
 */
@Injectable()
export class ReminderJobMetricsBinder implements OnModuleDestroy {
  constructor(private readonly pg: PgPoolFactory) {}

  onModuleInit(): void {
    setReminderJobMetricQuery(async (sql) =>
      this.pg.withTransaction(async (tx) => {
        const rows = await tx.query<ReminderJobSample>(sql);
        return rows.rows;
      }),
    );
  }

  onModuleDestroy(): void {
    // Teardown removes the seam — the gauges observe nothing until the next
    // boot registers a fresh query (initTelemetry's shutdown resets metrics
    // together with this, so no dangling closure survives a reload).
    resetReminderJobMetricQuery();
  }
}
