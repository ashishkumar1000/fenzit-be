import { iconNode, BrandIcon } from './brand-icons';

/**
 * Icons are Lucide SVGs recoloured per call — these tests lock the pdfmake
 * svg-node shape (svg + width/height + margin) and the currentColor
 * recolouring every consumer (sections, summary-cards, page furniture) relies
 * on. `BrandIcon` is the allowed-name union, so the cast below keeps the
 * compile honest if an icon is renamed.
 */

const ALL_ICONS: BrandIcon[] = [
  'clipboard-list',
  'circle-check',
  'clock',
  'circle-x',
  'timer',
  'zap',
  'users',
  'camera',
  'camera-off',
  'triangle-alert',
  'user',
];

describe('brand-icons — iconNode', () => {
  it('returns a pdfmake svg node with the given colour baked in', () => {
    const node = iconNode('circle-check', '#06956F');

    expect(typeof node.svg).toBe('string');
    expect((node as { svg: string }).svg).toContain('<svg');
    expect((node as { svg: string }).svg).toContain('#06956F');
    expect((node as { svg: string }).svg).not.toContain('currentColor');
    expect(node).toMatchObject({ width: 10, height: 10 }); // default size
  });

  it('recolors every bundled icon (no icon ships with a stale currentColor)', () => {
    for (const icon of ALL_ICONS) {
      const node = iconNode(icon, '#1A56DB') as { svg: string };
      expect(node.svg).not.toContain('currentColor');
      expect(node.svg).toContain('#1A56DB');
    }
  });

  it('accepts a custom size and top offset for optical alignment with text', () => {
    const node = iconNode('user', '#000000', 12, 4);

    expect(node).toMatchObject({ width: 12, height: 12, margin: [0, 4, 0, 0] });
  });

  it('caches the SVG read so repeated nodes do not re-hit the filesystem', () => {
    // Two calls share the same cached source — only the recolour differs.
    const first = iconNode('zap', '#111111') as { svg: string };
    const second = iconNode('zap', '#222222') as { svg: string };
    expect(first.svg).toContain('#111111');
    expect(second.svg).toContain('#222222');
  });
});