import {
  ImportRowField,
  ImportRowReason,
  ReasonCode,
  reasonFor,
} from './import-rows.types';

export interface Parsed<T> {
  value: T | null;
  reason?: ImportRowReason;
}

export const failed = <T>(
  field: ImportRowField,
  code: ReasonCode,
): Parsed<T> => ({
  value: null,
  reason: reasonFor(field, code),
});

/** Blank = missing, null, or whitespace only. */
export function isBlank(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    (typeof value === 'string' && value.trim() === '')
  );
}
