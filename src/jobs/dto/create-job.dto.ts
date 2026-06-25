import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
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
import { ServiceType } from '../enums/service-type.enum';
import { JobPriority } from '../enums/job-priority.enum';
import { NewCustomerDto } from './new-customer.dto';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

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

  @ApiProperty({ enum: ServiceType })
  @IsEnum(ServiceType)
  serviceType: ServiceType;

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

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  requireCompletionPhoto?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(2000)
  notesForTechnician?: string;
}
