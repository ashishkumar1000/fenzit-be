import { SetMetadata } from '@nestjs/common';

export const ALLOW_EXPIRED_SUBSCRIPTION_KEY = 'allowExpiredSubscription';

/**
 * Lets a route (or a whole controller) run for an owner whose company
 * subscription has ended. Used for device-token registration, which must keep
 * working so push tokens stay in step with the login. Sign-in routes are
 * public and never reach the subscription guard at all.
 */
export const AllowExpiredSubscription = () =>
  SetMetadata(ALLOW_EXPIRED_SUBSCRIPTION_KEY, true);
