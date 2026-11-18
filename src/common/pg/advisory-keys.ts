/**
 * The advisory-lock key strings shared across modules. These are STRING
 * contracts, not code contracts — every consumer hashes the same literal
 * (hashtextextended(key, 0)), so a rename here must land everywhere at once.
 *
 * Why a common home: the payroll month-serialization key is used by the
 * payroll module (lock, run engine) AND by the attendance date gate, and the
 * attendance/payroll seam rule forbids attendance importing payroll
 * internals — src/common is the neutral ground both sides already share.
 */

/**
 * The per-(tenant, month) payroll serialization key. Exclusive holders:
 * the month lock's decide+insert transaction and the run engine's payslip
 * write transaction. Shared holders: the attendance date gate (so a
 * correction cannot commit between a lock's decision and its insert, nor a
 * lock land under an in-flight correction's reads).
 */
export function payrollRunAdvisoryKey(tenantId: string, month: string): string {
  return `payroll-run:${tenantId}:${month}`;
}
