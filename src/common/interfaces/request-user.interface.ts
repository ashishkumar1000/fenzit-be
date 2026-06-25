import { Role } from '../enums/role.enum';

export interface RequestUser {
  userId: string;
  tenantId: string | null;
  role: Role;
  rawJwt: string;
}
