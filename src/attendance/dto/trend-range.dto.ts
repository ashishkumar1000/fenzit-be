import { ApiProperty } from '@nestjs/swagger';
import { Matches } from 'class-validator';
import { Transform } from 'class-transformer';
import { trim } from '../../common/utils/trim.transformer';

/**
 * Date window for the 2026-11-27 exec-dashboard attendance trend. Both ends
 * are required IST calendar days, inclusive — the chart always knows its
 * span. Real-date, ordering and size checks live in the service so the 422
 * can give the plain-English reason.
 */
export class TrendRangeDto {
  @ApiProperty({
    example: '2026-10-23',
    description: 'First IST day of the trend (YYYY-MM-DD).',
  })
  @Transform(trim)
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'from must be YYYY-MM-DD' })
  from!: string;

  @ApiProperty({
    example: '2026-11-21',
    description: 'Last IST day of the trend (YYYY-MM-DD).',
  })
  @Transform(trim)
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'to must be YYYY-MM-DD' })
  to!: string;
}
