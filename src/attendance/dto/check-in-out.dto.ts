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
 * accepted now and ignored until Epic 17 builds the leave model (spec D14)
 * so 16-4's client can send it from day one without a contract change.
 */
export class CheckInOutDto {
  @ApiProperty({ description: 'Fix latitude', minimum: -90, maximum: 90 })
  @IsNumber()
  @Min(-90)
  @Max(90)
  latitude!: number;

  @ApiProperty({ description: 'Fix longitude', minimum: -180, maximum: 180 })
  @IsNumber()
  @Min(-180)
  @Max(180)
  longitude!: number;

  @ApiProperty({ description: 'GPS accuracy in metres', minimum: 0 })
  @IsNumber()
  @Min(0)
  accuracyM!: number;

  @ApiPropertyOptional({
    description: 'True when the device reports the fix as mocked/simulated; null = not detected',
    nullable: true,
  })
  @IsOptional()
  @IsBoolean()
  mocked?: boolean | null = null;

  @ApiPropertyOptional({
    description: 'Informational only — the OS location provider',
    nullable: true,
  })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  provider?: string | null = null;

  @ApiProperty({
    description:
      'Age of the fix in milliseconds, computed by the client; > 30000 → stale_fix',
    minimum: 0,
    maximum: 86_400_000,
  })
  @Transform(({ value }) => (typeof value === 'string' ? Number(value) : value))
  @IsInt()
  @Min(0)
  // anything past a day is nonsense (the int4 column would also 22003 on
  // larger values); validation rejects before the DB is touched.
  @Max(86_400_000)
  fixAgeMs!: number;

  @ApiPropertyOptional({
    description: 'Unused until Epic 17 — confirms cancelling a full-day leave to check in',
  })
  @IsOptional()
  @IsBoolean()
  confirmLeaveCancel?: boolean;
}
