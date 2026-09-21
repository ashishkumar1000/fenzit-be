/**
 * Parses the Grafana Cloud `OTEL_EXPORTER_OTLP_HEADERS` env value into a
 * plain header map for the OTLP exporter.
 *
 * The value looks like `Authorization=Basic <base64>` (comma-separated for
 * multiple headers). Values are URL-encoded by the portal ("Basic " may
 * arrive as "Basic%20"), so each value is decoded.
 */
export function parseOtlpHeaders(
  raw: string | undefined,
): Record<string, string> {
  if (!raw?.trim()) return {};
  const headers: Record<string, string> = {};
  for (const pair of raw.split(',')) {
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    const key = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (!key || !value) continue;
    try {
      headers[key] = decodeURIComponent(value);
    } catch {
      headers[key] = value;
    }
  }
  return headers;
}
