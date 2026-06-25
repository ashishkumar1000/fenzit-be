import { ApiProperty } from '@nestjs/swagger';
import {
  IsString,
  Matches,
  MinLength,
  IsArray,
  ArrayMinSize,
  ArrayMaxSize,
  ArrayUnique,
  IsUUID,
} from 'class-validator';

export class InviteTechnicianDto {
  @ApiProperty({ example: '+91', description: 'Dial code (e.g. +91, +1, +44)' })
  @IsString()
  @Matches(/^\+\d{1,4}$/, {
    message: 'countryCode must be a valid dial code (e.g. +91)',
  })
  countryCode: string;

  @ApiProperty({
    example: '9876543210',
    description: 'Subscriber number without country code',
  })
  @IsString()
  @Matches(/^\d{6,15}$/, { message: 'phoneNumber must be 6–15 digits' })
  phoneNumber: string;

  @ApiProperty({ example: 'Ravi Kumar' })
  @IsString()
  @MinLength(1)
  name: string;

  @ApiProperty({
    type: [String],
    required: true,
    example: ['550e8400-e29b-41d4-a716-446655440001'],
    description:
      'Array of tenant skill UUIDs to assign to this technician (min 1, max 20)',
  })
  @IsArray()
  @ArrayMinSize(1, { message: 'At least one skill ID is required' })
  @ArrayMaxSize(20, { message: 'At most 20 skill IDs are allowed' })
  @ArrayUnique({ message: 'Skill IDs must be unique' })
  @IsUUID('all', { each: true, message: 'Each skill ID must be a valid UUID' })
  skillIds: string[];
}
