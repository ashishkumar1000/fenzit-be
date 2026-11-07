/**
 * GSTIN: 15 characters — 2-digit state, 5 letters, 4 digits, 1 letter,
 * entity code (1-9 or A-Z), the letter Z, then a check character.
 * Matches the database check `tenants_gstin_format` — keep them in step.
 */
export const GSTIN_PATTERN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
