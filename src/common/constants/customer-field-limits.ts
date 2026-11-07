/**
 * Length limits shared by manual customer create and the staff bulk import,
 * so both accept and refuse the same names and addresses. Counted in code
 * points (see common/validators/max-code-points.ts).
 */
export const CUSTOMER_NAME_MAX = 120;
export const CUSTOMER_ADDRESS_MAX = 255;
