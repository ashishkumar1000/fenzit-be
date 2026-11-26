import { ApiProperty } from '@nestjs/swagger';
import { IsDefined, IsUUID, ValidateIf } from 'class-validator';

/**
 * Body of PATCH /members/:userId/manager — the owner sets "Reports to".
 * `null` clears it (the member becomes unassigned and routes to the fallback
 * set). The key is required: an absent `managerId` is not "no change", it is
 * a malformed request.
 */
export class SetManagerDto {
  @ApiProperty({
    type: String,
    nullable: true,
    example: '550e8400-e29b-41d4-a716-446655440001',
    description:
      'The company member this person reports to, or null to clear it. Admins sit at the top of the tree and cannot be assigned a manager.',
  })
  @IsDefined({
    message: 'managerId is required — send a member id, or null to clear it',
  })
  @ValidateIf((o: SetManagerDto) => o.managerId !== null)
  @IsUUID('loose', { message: 'managerId must be a valid UUID or null' })
  managerId!: string | null;
}
