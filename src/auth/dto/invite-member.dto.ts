import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsString,
  Matches,
  MinLength,
  IsArray,
  ArrayMinSize,
  ArrayMaxSize,
  ArrayUnique,
  IsIn,
  IsOptional,
  IsUUID,
  ValidateIf,
} from 'class-validator';
import { MEMBERSHIP_ROLES, Role } from '../../common/enums/role.enum';
import type { MembershipRole } from '../../common/enums/role.enum';

export class InviteMemberDto {
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

  @ApiPropertyOptional({
    enum: MEMBERSHIP_ROLES,
    default: Role.EMPLOYEE,
    description:
      'Role inside the company. Defaults to employee. A company admin can set company_admin, employee or viewer, never platform_admin.',
  })
  @IsOptional()
  @IsIn(MEMBERSHIP_ROLES, {
    message: 'role must be company_admin, employee or viewer',
  })
  role?: MembershipRole;

  @ApiPropertyOptional({
    type: [String],
    example: ['550e8400-e29b-41d4-a716-446655440001'],
    description:
      'Global skills-catalog UUIDs (max 20). Optional for every role; an invite may go out with no skills.',
  })
  @ValidateIf((o: InviteMemberDto) => o.skillIds !== undefined)
  @IsArray()
  @ArrayMaxSize(20, { message: 'At most 20 skill IDs are allowed' })
  @ArrayUnique({ message: 'Skill IDs must be unique' })
  @IsUUID('loose', {
    each: true,
    message: 'Each skill ID must be a valid UUID',
  }) // never '4'/'all' (Story 1 trap; see leave.dto.ts)
  skillIds?: string[];

  @ApiPropertyOptional({
    example: '550e8400-e29b-41d4-a716-446655440002',
    description:
      'The company member this person reports to ("Reports to"). Must be an active member; a company admin cannot be given a manager. Omit for no reporting manager.',
  })
  @IsOptional()
  @IsUUID('loose', { message: 'managerId must be a valid UUID' })
  managerId?: string;
}
