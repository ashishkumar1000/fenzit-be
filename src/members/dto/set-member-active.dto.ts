import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';

/**
 * Body of PATCH /members/:userId/active — the owner's park/reinstate switch.
 * `false` deactivates an active member (they keep every record but lose
 * access); `true` reinstates a deactivated one.
 */
export class SetMemberActiveDto {
  @ApiProperty({ example: false, description: 'false deactivates, true reinstates' })
  @IsBoolean()
  active!: boolean;
}
