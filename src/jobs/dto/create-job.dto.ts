import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsISO8601,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { trim } from '../../common/utils/trim.transformer';
import { JobPriority } from '../enums/job-priority.enum';
import { NewCustomerDto } from './new-customer.dto';

export class CreateJobDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Existing customer UUID. Mutually exclusive with newCustomer.',
  })
  @IsOptional()
  @IsUUID() // default version 'all' — never '4' (Story 1 IsUUID('4') trap)
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
  @IsUUID() // default version 'all' — never '4' (Story 1 IsUUID('4') trap)
  skillId: string;

  @ApiProperty({ example: '2026-06-22T09:30:00Z' })
  @IsISO8601()
  scheduledStart: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  technicianId: string;

  @ApiPropertyOptional({ example: '2026-06-22T11:00:00Z' })
  @IsOptional()
  @IsISO8601()
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
