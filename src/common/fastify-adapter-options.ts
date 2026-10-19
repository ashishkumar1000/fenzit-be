// Shared Fastify router options — used by src/main.ts and by e2e bootstraps so
// tests see the same routing behaviour as real traffic.
export const FASTIFY_ROUTER_OPTIONS = {
  ignoreTrailingSlash: true,
  // R-03: Fastify's default maxParamLength (100) makes the router answer
  // 414 before any pipe runs, so an over-long :id never reached
  // ParseUUIDPipe (expected 400 VALIDATION_ERROR). 256 lets realistic
  // junk ids reach the pipes; the 8 KB HTTP header limit still caps the URL.
  maxParamLength: 256,
};
