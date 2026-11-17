import { HttpException } from '@nestjs/common';
import { SupabaseClientFactory } from '../common/factories/supabase-client.factory';
import { RequestUser } from '../common/interfaces/request-user.interface';
import { Role } from '../common/enums/role.enum';
import { SalaryStructuresService } from './salary-structures.service';
import { StoredLine } from './salary-structures.service';

/**
 * The structures service talks to three tables (memberships probe,
 * salary_components library, salary_structures read/upsert) plus the audit
 * rpc. The stand-in routes by table and call shape; every save-path rule the
 * spec names gets a case that proves the refusal AND that nothing was
 * written.
 */
function build(
  opts: {
    membershipRow?: Record<string, unknown> | null;
    libraryRows?: Array<Record<string, unknown>>;
    libraryError?: { code?: string; message: string } | null;
    existingRow?: Record<string, unknown> | null;
    listRows?: Array<Record<string, unknown>>;
    listError?: { code?: string; message: string } | null;
    upsertResult?: Record<string, unknown> | null;
    upsertError?: { code?: string; message: string } | null;
    membershipError?: { code?: string; message: string } | null;
    rpcRejects?: unknown;
  } = {},
) {
  const upsertPayloads: Array<Record<string, unknown>> = [];
  const rpcCalls: Array<Record<string, unknown>> = [];

  const mkBuilder = (table: string) => {
    const b: Record<string, unknown> = {};
    const eqCalls: Array<[string, unknown]> = [];
    let ordered = false;
    let upsertPayload: Record<string, unknown> | undefined;
    for (const name of ['neq', 'limit']) {
      b[name] = jest.fn(() => b);
    }
    b['eq'] = jest.fn((col: string, value: unknown) => {
      eqCalls.push([col, value]);
      return b;
    });
    b['order'] = jest.fn(() => {
      ordered = true;
      return b;
    });
    b['select'] = jest.fn(() => b);
    b['upsert'] = jest.fn((payload: Record<string, unknown>) => {
      upsertPayload = payload;
      upsertPayloads.push(payload);
      return b;
    });
    b['maybeSingle'] = jest.fn(() => b);
    b['single'] = jest.fn(() => b);
    b['then'] = (resolve: (v: unknown) => void) => {
      if (table === 'memberships') {
        resolve({
          data: opts.membershipError ? null : (opts.membershipRow ?? null),
          error: opts.membershipError ?? null,
        });
        return;
      }
      if (table === 'salary_components') {
        resolve({
          data: opts.libraryError ? null : (opts.libraryRows ?? []),
          error: opts.libraryError ?? null,
        });
        return;
      }
      // salary_structures
      if (upsertPayload !== undefined) {
        resolve({
          data: opts.upsertResult ?? null,
          error: opts.upsertError ?? null,
        });
        return;
      }
      if (ordered) {
        resolve({ data: opts.listRows ?? [], error: opts.listError ?? null });
        return;
      }
      resolve({ data: opts.existingRow ?? null, error: null });
    };
    return b;
  };

  const from = jest.fn((table: string) => mkBuilder(table));
  const rpc =
    opts.rpcRejects !== undefined
      ? jest.fn().mockRejectedValue(opts.rpcRejects)
      : jest
          .fn()
          .mockImplementation((fn: string, args: Record<string, unknown>) => {
            rpcCalls.push({ fn, ...args });
            return Promise.resolve({ data: null, error: null });
          });
  const admin = { from, rpc };
  const factory = {
    createAdmin: jest.fn(() => admin),
  } as unknown as jest.Mocked<SupabaseClientFactory>;
  const service = new SalaryStructuresService(factory);
  return { service, from, rpc, rpcCalls, upsertPayloads };
}

/** Captures the HttpException a refused save must raise, typed. */
async function httpError(
  promise: Promise<unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  try {
    await promise;
    throw new Error('expected the save to be refused');
  } catch (e) {
    const http = e as HttpException;
    return {
      status: http.getStatus(),
      body: http.getResponse() as Record<string, unknown>,
    };
  }
}

const companyAdmin: RequestUser = {
  userId: 'admin-1',
  tenantId: 'tenant-A',
  role: Role.COMPANY_ADMIN,
  platformAdmin: false,
  rawJwt: 'jwt',
};

const BASIC_ID = '11111111-1111-4111-8111-111111111111';
const HRA_ID = '22222222-2222-4222-8222-222222222222';
const SPECIAL_ID = '33333333-3333-4333-8333-333333333333';
const ZERO_ID = '44444444-4444-4444-8444-444444444444';

const libraryRows = (extra: Array<Record<string, unknown>> = []) => [
  { id: BASIC_ID, name: 'Basic', is_basic: true, active: true },
  { id: HRA_ID, name: 'HRA', is_basic: false, active: true },
  ...extra,
];

/** Canonical fixture variant A: basic 20,000 + HRA 40% of basic. */
const variantALines = () => [
  { componentId: BASIC_ID, amount: '20000.00' },
  {
    componentId: HRA_ID,
    formula: {
      kind: 'percent-of',
      percent: 40,
      of: { kind: 'component', componentId: BASIC_ID },
    },
  },
];

const savedRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'struct-1',
  tenant_id: 'tenant-A',
  membership_id: 'member-1',
  effective_from: '2026-09-01',
  lines: variantALines(),
  created_at: '2026-11-17T00:00:00Z',
  updated_at: '2026-11-17T00:00:00Z',
  ...overrides,
});

const putDto = (
  overrides: Partial<{ effectiveFrom: string; lines: unknown[] }> = {},
) => ({
  effectiveFrom: '2026-09-01',
  lines: variantALines(),
  ...overrides,
});

describe('SalaryStructuresService — the variant A save (CAP-2)', () => {
  it('saves basic 20,000 + HRA 40% and answers computed amounts (gross 28,000)', async () => {
    const t = build({
      membershipRow: { id: 'member-1', user_id: 'user-1' },
      libraryRows: libraryRows(),
      upsertResult: savedRow(),
    });
    const view = await t.service.save(companyAdmin, 'user-1', putDto());
    expect(view.lines.map((l) => l.computedAmount)).toEqual([
      '20000.00',
      '8000.00',
    ]);
    const payload = t.upsertPayloads[0];
    expect(payload).toMatchObject({
      tenant_id: 'tenant-A',
      membership_id: 'member-1',
      effective_from: '2026-09-01',
    });
    // Stored lines carry exact decimal text for amounts and the AST for
    // formulas — names never ride the row.
    expect((payload['lines'] as StoredLine[])[0]).toEqual({
      componentId: BASIC_ID,
      amount: '20000.00',
    });
    expect((payload['lines'] as StoredLine[])[1]).toMatchObject({
      componentId: HRA_ID,
    });
    // The payload stamps updated_at itself (no trigger exists): harmless on
    // insert, correct on the same-date replace.
    expect(typeof payload['updated_at']).toBe('string');
    expect(t.rpcCalls[0]).toMatchObject({
      p_action: 'payroll.structure_saved',
      p_target_user: 'user-1',
      p_details: { changed_fields: ['lines'], effective_from: '2026-09-01' },
    });
  });

  it('an identical re-save of the same date writes nothing and audits nothing', async () => {
    const t = build({
      membershipRow: { id: 'member-1', user_id: 'user-1' },
      libraryRows: libraryRows(),
      existingRow: savedRow(),
    });
    await t.service.save(companyAdmin, 'user-1', putDto());
    expect(t.upsertPayloads).toHaveLength(0);
    expect(t.rpcCalls).toHaveLength(0);
  });

  it('an upsert 23505 (same-date race) answers a plain-English 422', async () => {
    const t = build({
      membershipRow: { id: 'member-1', user_id: 'user-1' },
      libraryRows: libraryRows(),
      upsertError: { code: '23505', message: 'duplicate key' },
    });
    const err = await httpError(
      t.service.save(companyAdmin, 'user-1', putDto()),
    );
    expect(err.status).toBe(422);
    expect(String(err.body['message'])).toContain('2026-09-01');
    expect(String(err.body['message'])).toContain('landed first');
  });

  it('an upsert PGRST116 (membership vanished mid-save) is a 404', async () => {
    const t = build({
      membershipRow: { id: 'member-1', user_id: 'user-1' },
      libraryRows: libraryRows(),
      upsertError: { code: 'PGRST116', message: 'no rows' },
    });
    const err = await httpError(
      t.service.save(companyAdmin, 'user-1', putDto()),
    );
    expect(err.status).toBe(404);
    expect(err.body['error_code']).toBe('RESOURCE_NOT_FOUND');
  });

  it('a changed same-date save replaces the dated row (upsert on the unique pair)', async () => {
    const t = build({
      membershipRow: { id: 'member-1', user_id: 'user-1' },
      libraryRows: libraryRows(),
      existingRow: savedRow(),
      upsertResult: savedRow(),
    });
    await t.service.save(
      companyAdmin,
      'user-1',
      putDto({
        lines: [
          variantALines()[0],
          {
            ...variantALines()[1],
            formula: {
              kind: 'percent-of',
              percent: 50,
              of: { kind: 'component', componentId: BASIC_ID },
            },
          },
        ],
      }),
    );
    expect(t.upsertPayloads).toHaveLength(1);
    expect(t.rpcCalls[0]['p_action']).toBe('payroll.structure_saved');
  });
});

describe('SalaryStructuresService — every save rejection the spec names', () => {
  it.each([
    ['no lines', putDto({ lines: [] }), 'at least one component line'],
    [
      'the basic component missing',
      putDto({ lines: [variantALines()[1]] }),
      'every structure must include the basic component',
    ],
    [
      'an unknown component',
      putDto({
        lines: [
          variantALines()[0],
          {
            componentId: '99999999-9999-4999-8999-999999999999',
            amount: '1.00',
          },
        ],
      }),
      'not in your company library',
    ],
    [
      'a duplicated component',
      putDto({ lines: [variantALines()[0], { ...variantALines()[0] }] }),
      'one line per component',
    ],
    [
      'a negative amount',
      putDto({
        lines: [variantALines()[0], { componentId: HRA_ID, amount: '-5' }],
      }),
      '₹0 or more',
    ],
    [
      'a fractional-paise amount',
      putDto({
        lines: [variantALines()[0], { componentId: HRA_ID, amount: '10.999' }],
      }),
      'two decimal places',
    ],
    [
      'a 13-digit amount',
      putDto({
        lines: [
          variantALines()[0],
          { componentId: HRA_ID, amount: '9999999999999.00' },
        ],
      }),
      'at most 12 digits',
    ],
    [
      'a non-numeric amount',
      putDto({
        lines: [variantALines()[0], { componentId: HRA_ID, amount: 'abc' }],
      }),
      '₹0 or more',
    ],
    [
      'both amount and formula',
      putDto({
        lines: [
          variantALines()[0],
          { ...variantALines()[1], amount: '8000.00' },
        ],
      }),
      'exactly one of an amount or a formula',
    ],
    [
      'neither amount nor formula',
      putDto({ lines: [variantALines()[0], { componentId: HRA_ID }] }),
      'exactly one of an amount or a formula',
    ],
    [
      'a malformed formula',
      putDto({
        lines: [
          variantALines()[0],
          { componentId: HRA_ID, formula: { kind: 'modulo' } },
        ],
      }),
      'formula is not valid',
    ],
    [
      'an operand outside the structure',
      putDto({
        lines: [
          variantALines()[0],
          {
            componentId: HRA_ID,
            formula: {
              kind: 'percent-of',
              percent: 40,
              of: {
                kind: 'component',
                componentId: '99999999-9999-4999-8999-999999999999',
              },
            },
          },
        ],
      }),
      'no line in this salary structure',
    ],
    [
      'an operand whose component is absent from the payload',
      putDto({
        lines: [
          variantALines()[0],
          {
            componentId: HRA_ID,
            formula: { kind: 'component', componentId: SPECIAL_ID },
          },
        ],
      }),
      'no line in this salary structure',
    ],
  ])('rejects %s with a 422 and writes nothing', async (_name, dto, text) => {
    const t = build({
      membershipRow: { id: 'member-1', user_id: 'user-1' },
      libraryRows: libraryRows([
        { id: SPECIAL_ID, name: 'Special', is_basic: false, active: true },
      ]),
      existingRow: null,
    });
    const err = await httpError(t.service.save(companyAdmin, 'user-1', dto));
    expect(err.status).toBe(422);
    expect(String(err.body['message'])).toContain(text);
    expect(t.upsertPayloads).toHaveLength(0);
    expect(t.rpcCalls).toHaveLength(0);
  });

  it('rejects more than 100 component lines', async () => {
    const t = build({
      membershipRow: { id: 'member-1', user_id: 'user-1' },
      libraryRows: libraryRows(),
    });
    const many = Array.from({ length: 101 }, () => ({
      componentId: BASIC_ID,
      amount: '20000.00',
    }));
    const err = await httpError(
      t.service.save(companyAdmin, 'user-1', putDto({ lines: many })),
    );
    expect(err.status).toBe(422);
    expect(String(err.body['message'])).toContain('at most 100');
    expect(t.upsertPayloads).toHaveLength(0);
  });

  it('rejects a two-component cycle naming the chain, on the components as saved', async () => {
    const t = build({
      membershipRow: { id: 'member-1', user_id: 'user-1' },
      libraryRows: libraryRows([
        { id: SPECIAL_ID, name: 'Special', is_basic: false, active: true },
      ]),
    });
    const err = await httpError(
      t.service.save(
        companyAdmin,
        'user-1',
        putDto({
          lines: [
            variantALines()[0],
            {
              componentId: HRA_ID,
              formula: { kind: 'component', componentId: SPECIAL_ID },
            },
            {
              componentId: SPECIAL_ID,
              formula: { kind: 'component', componentId: HRA_ID },
            },
          ],
        }),
      ),
    );
    expect(err.status).toBe(422);
    expect(String(err.body['message'])).toContain('"HRA" → "Special" → "HRA"');
    expect(t.upsertPayloads).toHaveLength(0);
  });

  it('rejects division by a zero-amount operand', async () => {
    const t = build({
      membershipRow: { id: 'member-1', user_id: 'user-1' },
      libraryRows: libraryRows([
        { id: ZERO_ID, name: 'Zero', is_basic: false, active: true },
      ]),
    });
    const err = await httpError(
      t.service.save(
        companyAdmin,
        'user-1',
        putDto({
          lines: [
            variantALines()[0],
            { componentId: ZERO_ID, amount: '0.00' },
            {
              componentId: HRA_ID,
              formula: {
                kind: 'binary',
                op: '/',
                left: { kind: 'const', value: 100 },
                right: { kind: 'component', componentId: ZERO_ID },
              },
            },
          ],
        }),
      ),
    );
    expect(err.status).toBe(422);
    expect(String(err.body['message'])).toContain('divides by zero');
    expect(t.upsertPayloads).toHaveLength(0);
  });

  it('rejects a formula that computes a negative component', async () => {
    const t = build({
      membershipRow: { id: 'member-1', user_id: 'user-1' },
      libraryRows: libraryRows(),
    });
    const err = await httpError(
      t.service.save(
        companyAdmin,
        'user-1',
        putDto({
          lines: [
            variantALines()[0],
            {
              componentId: HRA_ID,
              formula: {
                kind: 'binary',
                op: '-',
                left: { kind: 'component', componentId: BASIC_ID },
                right: { kind: 'const', value: 25000 },
              },
            },
          ],
        }),
      ),
    );
    expect(err.status).toBe(422);
    expect(String(err.body['message'])).toContain('negative');
    expect(t.upsertPayloads).toHaveLength(0);
  });

  it('rejects a structure for a company with no basic component yet', async () => {
    const t = build({
      membershipRow: { id: 'member-1', user_id: 'user-1' },
      libraryRows: [
        { id: BASIC_ID, name: 'Basic', is_basic: false, active: true },
        { id: HRA_ID, name: 'HRA', is_basic: false, active: true },
      ],
    });
    const err = await httpError(
      t.service.save(
        companyAdmin,
        'user-1',
        putDto({ lines: [variantALines()[0]] }),
      ),
    );
    expect(err.status).toBe(422);
    expect(String(err.body['message'])).toContain('no basic component yet');
  });

  it('rejects a deactivated component by name', async () => {
    const t = build({
      membershipRow: { id: 'member-1', user_id: 'user-1' },
      libraryRows: [
        { id: BASIC_ID, name: 'Basic', is_basic: true, active: true },
        { id: HRA_ID, name: 'HRA', is_basic: false, active: false },
      ],
    });
    const err = await httpError(
      t.service.save(companyAdmin, 'user-1', putDto()),
    );
    expect(err.status).toBe(422);
    expect(String(err.body['message'])).toContain('deactivated');
  });
});

it('an amount written with leading zeros re-saves as a no-op', async () => {
  const t = build({
    membershipRow: { id: 'member-1', user_id: 'user-1' },
    libraryRows: libraryRows(),
    existingRow: savedRow({
      lines: [{ componentId: BASIC_ID, amount: '20000.00' }],
    }),
  });
  await t.service.save(
    companyAdmin,
    'user-1',
    putDto({ lines: [{ componentId: BASIC_ID, amount: '020000.00' }] }),
  );
  expect(t.upsertPayloads).toHaveLength(0);
  expect(t.rpcCalls).toHaveLength(0);
});

describe('SalaryStructuresService — reads and boundaries', () => {
  it('lists dated revisions oldest-first with names resolved at read time', async () => {
    const t = build({
      membershipRow: { id: 'member-1', user_id: 'user-1' },
      libraryRows: libraryRows(),
      listRows: [
        savedRow(),
        savedRow({
          id: 'struct-2',
          effective_from: '2026-11-01',
          lines: [
            { componentId: BASIC_ID, amount: '22000.00' },
            {
              componentId: HRA_ID,
              formula: {
                kind: 'percent-of',
                percent: 40,
                of: { kind: 'component', componentId: BASIC_ID },
              },
            },
          ],
        }),
      ],
    });
    const views = await t.service.list(companyAdmin, 'user-1');
    expect(views.map((v) => v.effectiveFrom)).toEqual([
      '2026-09-01',
      '2026-11-01',
    ]);
    expect(views[1].lines.map((l) => l.computedAmount)).toEqual([
      '22000.00',
      '8800.00',
    ]);
    expect(views[0].lines[1].componentName).toBe('HRA');
  });

  it('a stored line whose component left the library still renders (no computed amount)', async () => {
    const t = build({
      membershipRow: { id: 'member-1', user_id: 'user-1' },
      libraryRows: [
        { id: BASIC_ID, name: 'Basic', is_basic: true, active: true },
      ],
      listRows: [
        savedRow({
          lines: [
            { componentId: BASIC_ID, amount: '20000.00' },
            { componentId: HRA_ID, amount: '8000.00' },
          ],
        }),
      ],
    });
    const views = await t.service.list(companyAdmin, 'user-1');
    expect(views[0].lines[1].componentName).toBe('A removed component');
    expect(views[0].lines[1].computedAmount).toBe('8000.00');
  });

  it('a list failure is a 500 without DB text', async () => {
    const t = build({
      membershipRow: { id: 'member-1', user_id: 'user-1' },
      libraryRows: libraryRows(),
      listError: { code: 'XX000', message: 'boom' },
    });
    const err = await httpError(t.service.list(companyAdmin, 'user-1'));
    expect(err.status).toBe(500);
    expect(String(err.body['message'])).not.toContain('boom');
  });

  it('a non-member user id is a plain-English 404, never the record', async () => {
    const t = build({ membershipRow: null });
    const listErr = await httpError(t.service.list(companyAdmin, 'stranger'));
    expect(listErr.status).toBe(404);
    expect(listErr.body['error_code']).toBe('RESOURCE_NOT_FOUND');
    const saveErr = await httpError(
      t.service.save(companyAdmin, 'stranger', putDto()),
    );
    expect(saveErr.status).toBe(404);
    expect(t.upsertPayloads).toHaveLength(0);
  });

  it('a caller with no company is a 400 before any query', async () => {
    const t = build();
    const err = await httpError(
      t.service.list({ ...companyAdmin, tenantId: null }, 'user-1'),
    );
    expect(err.status).toBe(400);
    expect(t.from).not.toHaveBeenCalled();
  });

  it('an audit rpc rejection never undoes the save', async () => {
    const t = build({
      membershipRow: { id: 'member-1', user_id: 'user-1' },
      libraryRows: libraryRows(),
      upsertResult: savedRow(),
      rpcRejects: new Error('network down'),
    });
    const view = await t.service.save(companyAdmin, 'user-1', putDto());
    expect(view.effectiveFrom).toBe('2026-09-01');
  });
});
