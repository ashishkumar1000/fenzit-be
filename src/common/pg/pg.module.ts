import { Module } from '@nestjs/common';
import { PgPoolFactory } from './pg-pool.factory';

/**
 * Direct Postgres access (15-7). Imported only by AttendanceModule — no
 * other module grows raw-pg access in this story.
 */
@Module({
  providers: [PgPoolFactory],
  exports: [PgPoolFactory],
})
export class PgModule {}
