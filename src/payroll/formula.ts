/**
 * The guarded salary-formula language (CAP-2) as a typed AST, plus the
 * structure evaluator the save path (story 23-3) and the run engine (story
 * 23-6) share. Pure math and validation — no I/O anywhere in this file.
 *
 * The wire format is the AST JSON, never a string mini-language: it is
 * unambiguous to parse, trivially cycle-checkable and directly evaluable.
 * Components are referenced by UUID, never by name, so renaming a component
 * can never rewrite what a structure pays.
 *
 * Save-time rules (each rejected with a plain-English message):
 *   - shape: unknown kinds, non-finite numbers, depth > MAX_DEPTH,
 *     more than MAX_NODES nodes;
 *   - an operand referencing a component with no line in the structure;
 *   - a formula cycle, named as the chain of component names;
 *   - a division whose divisor evaluates to 0;
 *   - a component whose computed amount is negative.
 */

export const MAX_FORMULA_DEPTH = 8;
export const MAX_FORMULA_NODES = 32;
export const MAX_STRUCTURE_LINES = 100;

export type FormulaNode =
  | { kind: 'component'; componentId: string }
  | { kind: 'const'; value: number }
  | { kind: 'percent-of'; percent: number; of: FormulaNode }
  | {
      kind: 'binary';
      op: '+' | '-' | '*' | '/';
      left: FormulaNode;
      right: FormulaNode;
    };

export type FormulaParse =
  { ok: true; formula: FormulaNode } | { ok: false; message: string };

/** One structure line the evaluator works on (amounts already parsed). */
export interface StructureLineInput {
  componentId: string;
  name: string;
  amount?: number;
  formula?: FormulaNode;
}

export type StructureEvaluation =
  { ok: true; values: Map<string, number> } | { ok: false; message: string };

const BINARY_OPS: ReadonlySet<string> = new Set(['+', '-', '*', '/']);
const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Recursively validates the AST shape (kinds, finiteness, depth, size). */
export function parseFormulaShape(raw: unknown): FormulaParse {
  const fail = (message: string): FormulaParse => ({ ok: false, message });
  const walk = (
    node: unknown,
    depth: number,
    count: { n: number },
  ): FormulaParse => {
    if (depth > MAX_FORMULA_DEPTH) {
      return fail(
        `This formula is too deeply nested (maximum ${MAX_FORMULA_DEPTH} levels)`,
      );
    }
    if (!isPlainObject(node)) {
      return fail('A formula must be an object');
    }
    const kind = node['kind'];
    if (kind === 'component') {
      const componentId = node['componentId'];
      if (typeof componentId !== 'string' || componentId.length === 0) {
        return fail('A component reference needs a componentId');
      }
      count.n += 1;
      return count.n > MAX_FORMULA_NODES
        ? fail(`This formula is too large (maximum ${MAX_FORMULA_NODES} parts)`)
        : { ok: true, formula: { kind: 'component', componentId } };
    }
    if (kind === 'const') {
      const value = node['value'];
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return fail('A constant must be a finite number');
      }
      count.n += 1;
      return count.n > MAX_FORMULA_NODES
        ? fail(`This formula is too large (maximum ${MAX_FORMULA_NODES} parts)`)
        : { ok: true, formula: { kind: 'const', value } };
    }
    if (kind === 'percent-of') {
      const percent = node['percent'];
      if (
        typeof percent !== 'number' ||
        !Number.isFinite(percent) ||
        percent < 0
      ) {
        return fail('A percentage must be a number of 0 or more');
      }
      const inner = walk(node['of'], depth + 1, count);
      if (!inner.ok) return inner;
      count.n += 1;
      return count.n > MAX_FORMULA_NODES
        ? fail(`This formula is too large (maximum ${MAX_FORMULA_NODES} parts)`)
        : {
            ok: true,
            formula: {
              kind: 'percent-of',
              percent,
              of: (inner as { formula: FormulaNode }).formula,
            },
          };
    }
    if (kind === 'binary') {
      const op = node['op'];
      if (typeof op !== 'string' || !BINARY_OPS.has(op)) {
        return fail('A formula operation must be one of +, -, * or /');
      }
      const left = walk(node['left'], depth + 1, count);
      if (!left.ok) return left;
      const right = walk(node['right'], depth + 1, count);
      if (!right.ok) return right;
      count.n += 1;
      return count.n > MAX_FORMULA_NODES
        ? fail(`This formula is too large (maximum ${MAX_FORMULA_NODES} parts)`)
        : {
            ok: true,
            formula: {
              kind: 'binary',
              op: op as '+' | '-' | '*' | '/',
              left: (left as { formula: FormulaNode }).formula,
              right: (right as { formula: FormulaNode }).formula,
            },
          };
    }
    return fail(
      'A formula part must have kind component, const, percent-of or binary',
    );
  };
  return walk(raw, 1, { n: 0 });
}

/**
 * Evaluates every line of one structure against its own lines: amount lines
 * stand as they are, formula lines compute from the structure (formulas may
 * chain through other formula lines). Rejects operand references outside the
 * structure, cycles (naming the chain), zero-operand division and negative
 * computed amounts. Values are unrounded intermediates — rounding happens
 * once, at the payslip line (story 23-6).
 */
export function evaluateStructure(
  lines: StructureLineInput[],
): StructureEvaluation {
  const byId = new Map<string, StructureLineInput>();
  for (const line of lines) byId.set(line.componentId, line);

  const values = new Map<string, number>();
  // The evaluating chain of component ids, for cycle naming.
  const stack: string[] = [];
  const inStack = new Set<string>();

  const describeOperand = (node: FormulaNode): string => {
    if (node.kind === 'component') {
      const line = byId.get(node.componentId);
      return line ? `"${line.name}"` : 'a component outside this structure';
    }
    if (node.kind === 'const') return 'the constant 0';
    return 'a value that works out to 0';
  };

  /**
   * Evaluates one component THROUGH the cycle guard: pushes it on the
   * visiting chain, so a reference back to it names the full chain from its
   * own link (Alpha → Beta → Alpha), and memoizes the value no matter which
   * entry point reached it (top loop or nested reference).
   */
  const evalComponent = (line: StructureLineInput): number | string => {
    const memo = values.get(line.componentId);
    if (memo !== undefined) return memo;
    if (inStack.has(line.componentId)) {
      const start = stack.indexOf(line.componentId);
      const chain = [...stack.slice(start), line.componentId].map(
        (id) => `"${byId.get(id)?.name ?? id}"`,
      );
      return `This structure has a circular formula: ${chain.join(' → ')}. Each formula must ultimately compute from fixed amounts`;
    }
    if (line.amount !== undefined) {
      values.set(line.componentId, line.amount);
      return line.amount;
    }
    if (line.formula === undefined) {
      // Unreachable via the save path (a line is amount XOR formula);
      // guarded so a malformed caller cannot crash the run.
      return `"${line.name}" has neither an amount nor a formula in this structure`;
    }
    stack.push(line.componentId);
    inStack.add(line.componentId);
    const computed = evalNode(line.formula);
    stack.pop();
    inStack.delete(line.componentId);
    if (typeof computed === 'string') return computed;
    values.set(line.componentId, computed);
    return computed;
  };

  const evalNode = (node: FormulaNode): number | string => {
    if (node.kind === 'component') {
      const line = byId.get(node.componentId);
      if (!line) {
        return 'This formula refers to a component that has no line in this salary structure — every referenced component must be part of the structure';
      }
      return evalComponent(line);
    }
    if (node.kind === 'const') return node.value;
    if (node.kind === 'percent-of') {
      const base = evalNode(node['of']);
      if (typeof base === 'string') return base;
      return (base * node.percent) / 100;
    }
    const left = evalNode(node.left);
    if (typeof left === 'string') return left;
    const right = evalNode(node.right);
    if (typeof right === 'string') return right;
    if (node.op === '+') return left + right;
    if (node.op === '-') return left - right;
    if (node.op === '*') return left * right;
    if (right === 0) {
      return `This formula divides by zero — ${describeOperand(node.right)}, so it cannot be a divisor`;
    }
    return left / right;
  };

  for (const line of lines) {
    const computed = evalComponent(line);
    if (typeof computed === 'string') return { ok: false, message: computed };
  }

  for (const line of lines) {
    const value = values.get(line.componentId) ?? 0;
    if (!Number.isFinite(value)) {
      return {
        ok: false,
        message: `This structure makes "${line.name}" endlessly large — every component must work out to a finite amount`,
      };
    }
    if (value < 0) {
      return {
        ok: false,
        message: `This structure makes "${line.name}" negative (₹${moneyText(value)}) — every component must work out to ₹0 or more`,
      };
    }
  }
  return { ok: true, values };
}

/**
 * Half-up rounding to paise, applied ONCE per money figure (the run's
 * contract — intermediates stay unrounded). Negative-safe, though structure
 * validation never lets a negative through.
 *
 * The epsilon term rescues true-decimal .xx5 boundaries: their float
 * representation often sits just BELOW the boundary (1.005, 150.075), and a
 * plain floor would round them down. The term is scaled by magnitude so it
 * can never push a genuine .xx4 up.
 */
export function roundMoney(value: number): number {
  const sign = value < 0 ? -1 : 1;
  const scaled = Math.abs(value) * 100;
  return (sign * Math.floor(scaled + 0.5 + scaled * Number.EPSILON * 8)) / 100;
}

/** The display/storage form of a money figure: "24230.77". */
export function moneyText(value: number): string {
  return roundMoney(value).toFixed(2);
}
