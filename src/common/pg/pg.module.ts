import { Module } from '@nestjs/common';
import { PgPoolFactory } from './pg-pool.factory';

/**
 * Direct Postgres access (15-7). Consumers: AttendanceModule (the
 * transactional enrolment writes + the day-status reads) and, since 21-1,
 * ReportsModule — the report pipeline opens one `withTransaction` per
 * fetch so report fetchers can read the shared day-status grid
 * (common/day-status/grid-reader) through the same transaction discipline.
 * Since the 2026-10-26 web-admin spec, AdminModule too: the staff dossier
 * (admin/users/lookup) runs its read-only SELECT aggregation inside one
 * `withTransaction` for the same statement-timeout discipline.
 */
@Module({
  providers: [PgPoolFactory],
  exports: [PgPoolFactory],
})
export class PgModule {}
