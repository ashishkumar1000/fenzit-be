import { SetMetadata } from '@nestjs/common';

export const ANY_MEMBER_KEY = 'anyMember';

/**
 * Open to any signed-in user, with or without a company (decision 10). Used by
 * company setup, `GET /users/me`, notifications, skills and the realtime token.
 * Such handlers must filter by the caller's own user ID.
 */
export const AnyMember = () => SetMetadata(ANY_MEMBER_KEY, true);
