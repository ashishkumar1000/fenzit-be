import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';
import { MEMBERSHIP_ROLES } from '../../common/enums/role.enum';
import type { MembershipRole } from '../../common/enums/role.enum';

export class ChangeRoleDto {
  @ApiProperty({
    enum: MEMBERSHIP_ROLES,
    description:
      'The new role inside the company. `platform_admin` is never accepted here.',
  })
  @IsIn(MEMBERSHIP_ROLES, {
    message: 'role must be company_admin, employee or viewer',
  })
  role: MembershipRole;
}
