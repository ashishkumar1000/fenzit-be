import { Role } from '../enums/role.enum';

/**
 * The caller, as the backend sees them on this request. Built by
 * JwtAuthGuard from the database (never from the token): the token only says
 * who the person is.
 */
export interface RequestUser {
  userId: string;
  /** The company this request acts on. Null when the person has no company
   *  (or is a platform admin who named none). */
  tenantId: string | null;
  /** `platform_admin` for fenzit staff, the membership role otherwise, or null
   *  when the person has no active membership. */
  role: Role | null;
  platformAdmin: boolean;
  rawJwt: string;
}
