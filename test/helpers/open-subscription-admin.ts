/**
 * Wraps a test's admin-client mock so the two `tenants` reads the app makes
 * are answered, and every other table goes to the test's own mock.
 *
 * - The subscription gate (SubscriptionExpiryGuard, runs on every owner write)
 *   reads validity_until: answered as "no expiry set". It has its own unit spec.
 * - The invite SMS path reads company_name: answered as a fixed company.
 *
 * Without this, a suite whose mocks do not model `tenants` fails in the guard
 * before the handler runs, with a 500.
 */
export function withOpenSubscription(
  admin: Record<string, unknown> | undefined,
  companyName = 'Jobzo Services',
) {
  return {
    ...admin,
    from: (table: string) => {
      if (table === 'tenants') {
        const row = { company_name: companyName, validity_until: null };
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: row, error: null }),
              single: async () => ({ data: row, error: null }),
            }),
          }),
        };
      }
      const from = admin?.['from'] as ((t: string) => unknown) | undefined;
      if (!from) throw new Error(`unexpected table ${table}`);
      return from(table);
    },
  };
}
