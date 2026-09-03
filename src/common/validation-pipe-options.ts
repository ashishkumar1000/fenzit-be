import { ValidationPipeOptions } from '@nestjs/common';

/**
 * Global ValidationPipe options — the single source of truth. `main.ts`
 * installs this exact config on every request, so the behaviours it selects
 * are part of the API contract, not test conveniences:
 *   - `errorHttpStatusCode: 422` — validation failures are 422, not 400
 *     (clients distinguish "your input was bad" from "your request was broken").
 *   - `whitelist: true` + `forbidNonWhitelisted: false` — unknown query/body
 *     keys are silently stripped, never rejected.
 *   - `transform: true` — DTOs are instantiated (transforms like `toArray` run).
 * Test bootstraps must import this instead of copying the object, or they
 * validate against a stale replica that can drift from the real API.
 */
export const VALIDATION_PIPE_OPTIONS: ValidationPipeOptions = {
  whitelist: true,
  forbidNonWhitelisted: false,
  transform: true,
  errorHttpStatusCode: 422,
};
