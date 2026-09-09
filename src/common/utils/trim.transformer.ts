import type { TransformFnParams } from 'class-transformer';

/**
 * Trims a string value in place (non-strings pass through untouched).
 */
export const trim = ({ value }: TransformFnParams): unknown =>
  typeof value === 'string' ? value.trim() : value;

/**
 * Trims a string value and maps an empty result to undefined, so an empty or
 * whitespace-only query param (`?cursor=`) is treated as "not provided" rather
 * than surfacing as a validation error downstream.
 */
export const trimToUndefined = ({ value }: TransformFnParams): unknown => {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
};

/**
 * Trims every string element of an array value in place — for bulk-id DTOs
 * whose per-element validators (@IsUUID({ each: true })) run after the
 * transform, so a padded id would otherwise fail validation.
 */
export const trimArray = ({ value }: TransformFnParams): unknown =>
  Array.isArray(value)
    ? value.map((v: unknown) => (typeof v === 'string' ? v.trim() : v))
    : value;
