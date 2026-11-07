import {
  ImportRowDraft,
  ImportRowResult,
  ImportValidateResponse,
  reasonFor,
} from './import-rows.types';

/**
 * Adds the sheet-wide checks. Every occurrence of a phone that appears twice
 * in the sheet is invalid (the commit would update the same customer twice,
 * so the sheet is ambiguous). A phone that matches an existing customer is
 * not an error: it is flagged as an update.
 */
export function finaliseImportRows(
  drafts: ImportRowDraft[],
  existingByPhone: ReadonlyMap<string, string>,
): ImportValidateResponse {
  const occurrences = new Map<string, number>();
  for (const draft of drafts) {
    if (draft.phoneKey) {
      occurrences.set(
        draft.phoneKey,
        (occurrences.get(draft.phoneKey) ?? 0) + 1,
      );
    }
  }

  const rows: ImportRowResult[] = drafts.map((draft) => {
    const reasons = [...draft.reasons];
    if (draft.phoneKey && (occurrences.get(draft.phoneKey) ?? 0) > 1) {
      reasons.push(reasonFor('phone', 'PHONE_DUPLICATE_IN_SHEET'));
    }
    const existingCustomerId = draft.phoneKey
      ? (existingByPhone.get(draft.phoneKey) ?? null)
      : null;
    const flags = [...draft.flags];
    if (existingCustomerId !== null) flags.push('updates_existing');
    return {
      rowIndex: draft.rowIndex,
      status: reasons.length === 0 ? 'valid' : 'invalid',
      normalised: draft.values,
      reasons,
      flags,
      existingCustomerId,
    };
  });

  const count = (predicate: (row: ImportRowResult) => boolean) =>
    rows.filter(predicate).length;
  return {
    rows,
    summary: {
      total: rows.length,
      valid: count((r) => r.status === 'valid'),
      invalid: count((r) => r.status === 'invalid'),
      willUpdateExisting: count((r) => r.flags.includes('updates_existing')),
      noMapPin: count((r) => r.flags.includes('no_map_pin')),
    },
  };
}
