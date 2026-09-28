import { haversineDistanceM } from './geo';

/**
 * The server-side distance (16-1): the PRD's geofence verdict comes from
 * THIS function, so its anchors are pinned to known city pairs rather than
 * formula restatements.
 */
describe('haversineDistanceM', () => {
  it('is 0 for an identical point', () => {
    expect(haversineDistanceM(19.076, 72.8777, 19.076, 72.8777)).toBe(0);
  });

  it('measures a known short pair within a metre (Thane ↔ nearby)', () => {
    // ~111 m apart north-south (0.001° latitude).
    const d = haversineDistanceM(19.076, 72.8777, 19.077, 72.8777);
    expect(d).toBeGreaterThan(105);
    expect(d).toBeLessThan(115);
  });

  it('measures a long pair within a kilometre (Mumbai ↔ Delhi ≈ 1150 km)', () => {
    const d = haversineDistanceM(
      19.076,
      72.8777,
      28.6139,
      77.209,
    );
    expect(d).toBeGreaterThan(1_140_000);
    expect(d).toBeLessThan(1_160_000);
  });

  it('never returns NaN for antipodal points', () => {
    const d = haversineDistanceM(0, 0, 0, 180);
    expect(Number.isFinite(d)).toBe(true);
    expect(d).toBeGreaterThan(20_000_000 - 100_000);
    expect(d).toBeLessThan(20_000_000 + 100_000);
  });

  it('is symmetric', () => {
    const ab = haversineDistanceM(19.076, 72.8777, 28.6139, 77.209);
    const ba = haversineDistanceM(28.6139, 77.209, 19.076, 72.8777);
    expect(ab).toBeCloseTo(ba, 6);
  });
});
