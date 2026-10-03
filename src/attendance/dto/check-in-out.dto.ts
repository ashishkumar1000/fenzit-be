import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * The AD-20 capture object — the identical body both check-in and
 * check-out accept (16-1/16-2). The server makes every decision (PRD);
 * these fields describe the fix, they never carry verdicts. `mocked: null`
 * means "not detected" (best-effort detection). `confirmLeaveCancel` is
 * consumed by the check-in transaction's leave-confirmation path since
 * 17-4 (D11 — it authorises the auto-cancel of a full-day leave); the
 * other paths ignore it, and the FE only ever sends it from that dialog.
 */
export class CheckInOutDto {
  @ApiProperty({ description: 'Fix latitude', minimum: -90, maximum: 90 })
  @IsNumber(undefined, { message: 'Please try again with a clearer location.' })
  @Min(-90, { message: 'Please try again with a clearer location.' })
  @Max(90, { message: 'Please try again with a clearer location.' })
  latitude!: number;

  @ApiProperty({ description: 'Fix longitude', minimum: -180, maximum: 180 })
  @IsNumber(undefined, { message: 'Please try again with a clearer location.' })
  @Min(-180, { message: 'Please try again with a clearer location.' })
  @Max(180, { message: 'Please try again with a clearer location.' })
  longitude!: number;

  @ApiProperty({ description: 'GPS accuracy in metres', minimum: 0 })
  @IsNumber(undefined, { message: 'Please try again with a clearer location.' })
  @Min(0, { message: 'Please try again with a clearer location.' })
  accuracyM!: number;

  @ApiPropertyOptional({
    description:
      'True when the device reports the fix as mocked/simulated; null = not detected',
    nullable: true,
  })
  @IsOptional()
  @IsBoolean({ message: 'Something went wrong. Please try once more.' })
  mocked?: boolean | null = null;

  @ApiPropertyOptional({
    description: 'Informational only — the OS location provider',
    nullable: true,
  })
  @IsOptional()
  @IsString({ message: 'Please try again with a clearer location.' })
  @MaxLength(40, { message: 'Please try again with a clearer location.' })
  provider?: string | null = null;

  @ApiProperty({
    description:
      'Age of the fix in milliseconds, computed by the client; > 30000 → stale_fix',
    minimum: 0,
    maximum: 86_400_000,
  })
  @Transform(({ value }) => (typeof value === 'string' ? Number(value) : value))
  @IsInt({ message: 'Please try again with a clearer location.' })
  @Min(0, { message: 'Please try again with a clearer location.' })
  // anything past a day is nonsense (the int4 column would also 22003 on
  // larger values); validation rejects before the DB is touched.
  @Max(86_400_000, { message: 'Please try again with a clearer location.' })
  fixAgeMs!: number;

  @ApiPropertyOptional({
    description:
      'Confirms cancelling a full-day active leave for today (FR-9); without it the check-in answers leave_confirmation_required',
  })
  @IsOptional()
  @IsBoolean({ message: 'Something went wrong. Please try once more.' })
  confirmLeaveCancel?: boolean;
}
