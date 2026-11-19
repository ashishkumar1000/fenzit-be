import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsEnum,
  IsISO8601,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { trim } from '../../common/utils/trim.transformer';
import { JobPriority } from '../enums/job-priority.enum';
import { NewCustomerDto } from './new-customer.dto';

// A schedule time must say which time zone it is in ("Z" or "+05:30"). Without
// it the server would read the time in its own zone, so the IST check would
// depend on where the server runs.
const TIME_ZONE_OFFSET_RE = /(Z|[+-]\d{2}:\d{2})$/i;
const TIME_ZONE_OFFSET_MESSAGE =
  'Include the time zone, for example 2030-06-22T09:30:00+05:30 or 2030-06-22T09:30:00Z';

export class CreateJobDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Existing customer UUID. Mutually exclusive with newCustomer.',
  })
  @IsOptional()
  // 'loose' — never '4'/'all' (Story 1 trap, re-found 2026-11-20: class-validator's
  // 'all' rejects 83/173 real seeded ids; see attendance/dto/leave.dto.ts)
  @IsUUID('loose')
  customerId?: string;

  @ApiPropertyOptional({
    type: () => NewCustomerDto,
    description:
      'Inline customer to find-or-create. Mutually exclusive with customerId.',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => NewCustomerDto)
  newCustomer?: NewCustomerDto;

  @ApiProperty({ example: '12 MG Road, Bengaluru' })
  @Transform(trim)
  @IsString()
  @IsNotEmpty({ message: 'serviceLocation must not be empty or whitespace' })
  @MaxLength(500)
  serviceLocation: string;

  @ApiProperty({
    format: 'uuid',
    description:
      'Global skills-catalog UUID — exactly what GET /skills serves. ' +
      'Validated against the active catalog before the create RPC runs.',
  })
  @IsUUID('loose') // never '4'/'all' (Story 1 trap; see leave.dto.ts)
  skillId: string;

  @ApiProperty({
    example: '2030-06-22T09:30:00+05:30',
    description:
      'Start time with a time-zone offset (Z or +hh:mm). Must be today (IST) or later.',
  })
  @IsISO8601()
  @Matches(TIME_ZONE_OFFSET_RE, { message: TIME_ZONE_OFFSET_MESSAGE })
  scheduledStart: string;

  @ApiProperty({ format: 'uuid' })
  // 'loose' — a REAL user id; bare 'all' rejects 83/173 of them in the wild
  @IsUUID('loose')
  technicianId: string;

  @ApiPropertyOptional({
    example: '2030-06-22T11:00:00+05:30',
    description: 'End time with a time-zone offset (Z or +hh:mm).',
  })
  @IsOptional()
  @IsISO8601()
  @Matches(TIME_ZONE_OFFSET_RE, { message: TIME_ZONE_OFFSET_MESSAGE })
  scheduledEnd?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiPropertyOptional({ enum: JobPriority, default: JobPriority.NORMAL })
  @IsOptional()
  @IsEnum(JobPriority)
  priority?: JobPriority;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(2000)
  notesForTechnician?: string;
}
