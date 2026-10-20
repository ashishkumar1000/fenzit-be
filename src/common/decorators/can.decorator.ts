import { SetMetadata } from '@nestjs/common';
import { Permission } from '../permissions/permissions';

export const CAN_KEY = 'can';

/**
 * The permission(s) an endpoint needs (any one of the listed is enough).
 * An endpoint with none of `@Can`, `@Public` or `@AnyMember` is refused.
 */
export const Can = (...permissions: Permission[]) =>
  SetMetadata(CAN_KEY, permissions);
