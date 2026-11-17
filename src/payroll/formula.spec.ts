import {
  evaluateStructure,
  moneyText,
  parseFormulaShape,
  roundMoney,
  StructureLineInput,
  MAX_FORMULA_DEPTH,
  MAX_FORMULA_NODES,
} from './formula';

/**
 * Tests the REQUIREMENT, not the code: a formula language that must reject
 * cycles (naming the chain), operands outside the structure, division by a
 * zero amount and negative pay, and must evaluate the fixture's arithmetic
 * (basic 20,000 + HRA 40% → gross 28,000).
 */

const basic = (amount: string): StructureLineInput => ({
  componentId: 'basic-id',
  name: 'Basic',
  amount: Number(amount),
});
const line = (
  id: string,
  name: string,
  formulaRaw: unknown,
): StructureLineInput => {
  const parsed = parseFormulaShape(formulaRaw);
  if (!parsed.ok) throw new Error(`invalid test formula: ${parsed.message}`);
  return { componentId: id, name, formula: parsed.formula };
};
const ref = (id: string) => ({ kind: 'component', componentId: id });
const pct = (percent: number, of: unknown) => ({
  kind: 'percent-of',
  percent,
  of,
});
const bin = (op: '+' | '-' | '*' | '/', left: unknown, right: unknown) => ({
  kind: 'binary',
  op,
  left,
  right,
});

describe('parseFormulaShape — the guarded language', () => {
  it.each([
    ['component', ref('x'), true],
    ['const', { kind: 'const', value: 5000 }, true],
    ['percent-of', pct(40, ref('x')), true],
    ['binary', bin('+', ref('x'), { kind: 'const', value: 1 }), true],
  ])('accepts a well-formed %s node', (_name, node, ok) => {
    expect(parseFormulaShape(node).ok).toBe(ok);
  });

  it.each([
    ['unknown kind', { kind: 'modulo' }],
    ['missing componentId', { kind: 'component' }],
    ['empty componentId', { kind: 'component', componentId: '' }],
    ['non-finite const', { kind: 'const', value: Number.NaN }],
    ['Infinity const', { kind: 'const', value: Number.POSITIVE_INFINITY }],
    ['negative percent', pct(-40, ref('x'))],
    ['non-finite percent', { kind: 'percent-of', percent: '40', of: ref('x') }],
    ['bad op', bin('%', ref('x'), ref('y'))],
    ['non-object', 'basic * 0.4'],
    ['array node', [ref('x')]],
    ['missing operand', { kind: 'binary', op: '+', left: ref('x') }],
  ])('rejects %s in plain English', (_name, node) => {
    const parsed = parseFormulaShape(node);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.message).toMatch(/[a-zA-Z]/);
      expect(parsed.message).not.toMatch(/SQL|postgres|db/i);
    }
  });

  it('rejects nesting beyond the depth cap', () => {
    let node: unknown = ref('x');
    for (let i = 0; i <= MAX_FORMULA_DEPTH; i += 1) {
      node = pct(1, node);
    }
    const parsed = parseFormulaShape(node);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.message).toContain('deeply nested');
  });

  it('accepts nesting exactly at the depth cap', () => {
    let node: unknown = ref('x');
    for (let i = 0; i < MAX_FORMULA_DEPTH - 1; i += 1) {
      node = pct(1, node);
    }
    expect(parseFormulaShape(node).ok).toBe(true);
  });

  it('rejects a formula larger than the node cap (wide tree, depth stays legal)', () => {
    const tree = (depth: number): unknown =>
      depth === 0 ? ref('x') : bin('+', tree(depth - 1), tree(depth - 1));
    // A complete binary tree at depth d holds 2^(d+1)-1 nodes: pick the
    // shallowest depth that exceeds the size cap while staying under the
    // depth cap, so the size rule is what rejects it.
    const depth = Math.ceil(Math.log2(MAX_FORMULA_NODES + 1)) + 1;
    expect(2 ** (depth + 1) - 1).toBeGreaterThan(MAX_FORMULA_NODES);
    expect(depth).toBeLessThan(MAX_FORMULA_DEPTH);
    const parsed = parseFormulaShape(tree(depth));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.message).toContain('too large');
  });
});

describe('evaluateStructure — the fixture arithmetic', () => {
  it('computes the canonical variant A: basic 20,000 + HRA 40% → 8,000 (gross 28,000)', () => {
    const result = evaluateStructure([
      basic('20000.00'),
      line('hra-id', 'HRA', pct(40, ref('basic-id'))),
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.values.get('basic-id')).toBe(20000);
      expect(result.values.get('hra-id')).toBeCloseTo(8000, 8);
    }
  });

  it('chains through formula lines: C = HRA + 5,000 → 13,000', () => {
    const result = evaluateStructure([
      basic('20000.00'),
      line('hra-id', 'HRA', pct(40, ref('basic-id'))),
      line(
        'c-id',
        'Special',
        bin('+', ref('hra-id'), { kind: 'const', value: 5000 }),
      ),
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.values.get('c-id')).toBeCloseTo(13000, 8);
  });

  it('evaluates percent-of around a nested expression', () => {
    const result = evaluateStructure([
      basic('20000.00'),
      line(
        'c-id',
        'Special',
        pct(10, bin('*', ref('basic-id'), { kind: 'const', value: 2 })),
      ),
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.values.get('c-id')).toBeCloseTo(4000, 8);
  });

  it('divides and multiplies: 100 ÷ basic% — fractional intermediates stay unrounded', () => {
    const result = evaluateStructure([
      basic('3.00'),
      line(
        'c-id',
        'Odd',
        bin('/', { kind: 'const', value: 100 }, ref('basic-id')),
      ),
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.values.get('c-id')).toBeCloseTo(33.333333333333336, 10);
    }
  });

  it('an intermediate that dips negative but lands positive is legal math', () => {
    const result = evaluateStructure([
      basic('20000.00'),
      line(
        'c-id',
        'Netting',
        bin('+', bin('-', ref('basic-id'), { kind: 'const', value: 30000 }), {
          kind: 'const',
          value: 15000,
        }),
      ),
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.values.get('c-id')).toBe(5000);
  });
});

describe('evaluateStructure — every rejection the spec names', () => {
  it('rejects an operand with no line in the structure', () => {
    const result = evaluateStructure([
      line('hra-id', 'HRA', pct(40, ref('ghost-id'))),
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.message).toContain('no line in this salary structure');
  });

  it('rejects a two-component cycle NAMING the chain', () => {
    const result = evaluateStructure([
      line('a-id', 'Alpha', ref('b-id')),
      line('b-id', 'Beta', ref('a-id')),
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain('circular');
      expect(result.message).toContain('"Alpha" → "Beta" → "Alpha"');
    }
  });

  it('rejects a self-referencing formula naming the single-link chain', () => {
    const result = evaluateStructure([line('a-id', 'Alpha', ref('a-id'))]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('"Alpha" → "Alpha"');
  });

  it('rejects a cycle reached through a longer chain (whole set re-checked)', () => {
    const result = evaluateStructure([
      basic('20000.00'),
      line(
        'a-id',
        'Alpha',
        bin('+', ref('b-id'), { kind: 'const', value: 100 }),
      ),
      line(
        'b-id',
        'Beta',
        bin('+', ref('c-id'), { kind: 'const', value: 100 }),
      ),
      line(
        'c-id',
        'Gamma',
        bin('+', ref('a-id'), { kind: 'const', value: 100 }),
      ),
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain('circular');
      expect(result.message).toMatch(/"Alpha" → "Beta" → "Gamma" → "Alpha"/);
    }
  });

  it('rejects division by a zero-amount component', () => {
    const result = evaluateStructure([
      basic('20000.00'),
      { componentId: 'zero-id', name: 'Zero', amount: 0 },
      line(
        'c-id',
        'Per',
        bin('/', { kind: 'const', value: 100 }, ref('zero-id')),
      ),
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('divides by zero');
  });

  it('rejects division by the constant 0', () => {
    const result = evaluateStructure([
      basic('20000.00'),
      line(
        'c-id',
        'Per',
        bin('/', ref('basic-id'), { kind: 'const', value: 0 }),
      ),
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('divides by zero');
  });

  it('rejects division by a sub-expression that computes to 0', () => {
    const result = evaluateStructure([
      basic('20000.00'),
      line(
        'c-id',
        'Per',
        bin('/', ref('basic-id'), bin('-', ref('basic-id'), ref('basic-id'))),
      ),
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('divides by zero');
  });

  it('rejects a formula that computes a negative component', () => {
    const result = evaluateStructure([
      basic('20000.00'),
      line(
        'c-id',
        'Shortfall',
        bin('-', ref('basic-id'), { kind: 'const', value: 25000 }),
      ),
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('negative');
    if (!result.ok) expect(result.message).toContain('"Shortfall"');
  });

  it('rejects a formula that overflows to Infinity', () => {
    const result = evaluateStructure([
      { componentId: 'big-id', name: 'Big', amount: 1e300 },
      line(
        'c-id',
        'Bigger',
        bin('*', ref('big-id'), { kind: 'const', value: 1e300 }),
      ),
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('endlessly large');
  });

  it('rejects a negative FIXED amount too', () => {
    const result = evaluateStructure([
      basic('20000.00'),
      { componentId: 'c-id', name: 'Odd', amount: -5 },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('negative');
  });
});

describe('money rounding — half-up, once', () => {
  it.each([
    [28000 / 26, '1076.92'],
    [(28000 / 26) * 22.5, '24230.77'],
    [0.005, '0.01'],
    [0.004, '0.00'],
    [1.005, '1.01'], // the float sits BELOW the .xx5 boundary — half-up rescues it
    [150.075, '150.08'], // 15% of ₹1,000.50 — the payslip boundary case
    [8000, '8000.00'],
    [2.675, '2.68'], // this one lands exactly ON the boundary in IEEE doubles
    [-1234.567, '-1234.57'],
  ])('rounds %p half-up to %s', (value, expected) => {
    expect(moneyText(value)).toBe(expected);
    expect(roundMoney(value)).toBe(Number(expected));
  });
});
