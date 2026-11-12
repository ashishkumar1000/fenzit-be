import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, Matches } from 'class-validator';
import { Transform } from 'class-transformer';
import { trim } from '../../common/utils/trim.transformer';

/**
 * Date window for the reports (story 6). Both ends are IST calendar days,
 * inclusive. The service checks the dates are real and the window is at most
 * 366 days; a shape-only check here lets the service give the plain-English reason.
 */
export class JobReportRangeDto {
  @ApiPropertyOptional({
    example: '2026-10-14',
    description:
      'First IST day of the window (YYYY-MM-DD). Default: 29 days before `to`.',
  })
  @IsOptional()
  @Transform(trim)
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'from must be YYYY-MM-DD' })
  from?: string;

  @ApiPropertyOptional({
    example: '2026-11-12',
    description:
      'Last IST day of the window (YYYY-MM-DD). Default: today in IST.',
  })
  @IsOptional()
  @Transform(trim)
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'to must be YYYY-MM-DD' })
  to?: string;
}
