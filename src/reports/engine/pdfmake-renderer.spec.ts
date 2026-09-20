/**
 * Access-policy seam and bind-time wiring of the pdfmake renderer, tested
 * against a mock of the pdfmake CJS singleton (the real render is smoke-
 * tested separately in pdfmake-renderer.render.spec.ts — one jest.mock away,
 * and pdfmake must never be imported as named ESM from Bun).
 */
jest.mock('pdfmake', () => ({
  setUrlAccessPolicy: jest.fn(),
  setLocalAccessPolicy: jest.fn(),
  addFonts: jest.fn(),
  createPdf: jest.fn(),
}));

import { PDF_RENDERER, PdfRenderer } from './pdf-renderer.port';
import { PdfmakeRenderer } from './pdfmake-renderer';
import { fontDescriptor, fontsDir } from '../templates/brand-kit/brand-assets';
import { ReportsModule } from '../reports.module';

const pdfmake = jest.requireMock('pdfmake') as {
  setUrlAccessPolicy: jest.Mock;
  setLocalAccessPolicy: jest.Mock;
  addFonts: jest.Mock;
  createPdf: jest.Mock;
};

describe('PdfmakeRenderer — bind-time wiring', () => {
  it('locks the process-wide policies and registers the brand fonts exactly once', () => {
    new PdfmakeRenderer();
    new PdfmakeRenderer(); // second instance must not re-register

    expect(pdfmake.setUrlAccessPolicy).toHaveBeenCalledTimes(1);
    expect(pdfmake.setLocalAccessPolicy).toHaveBeenCalledTimes(1);
    expect(pdfmake.addFonts).toHaveBeenCalledTimes(1);
    expect(pdfmake.addFonts).toHaveBeenCalledWith(fontDescriptor);
  });

  it('denies every external URL — a doc definition cannot make the renderer fetch', () => {
    new PdfmakeRenderer();

    const deny = pdfmake.setUrlAccessPolicy.mock.calls[0][0] as (
      url: string,
    ) => boolean;
    expect(deny('https://evil.example.com/exfil.png')).toBe(false);
    expect(deny('http://169.254.169.254/latest/meta-data')).toBe(false);
    expect(
      deny('data:image/svg+xml;base64,PHN2Zy8+'),
    ).toBe(false);
  });

  it('allowlists local file reads to the bundled fonts dir only', () => {
    new PdfmakeRenderer();

    const allow = pdfmake.setLocalAccessPolicy.mock.calls[0][0] as (
      path: string,
    ) => boolean;
    expect(allow(fontsDir)).toBe(true);
    expect(allow(fontsDir + '/Inter-Regular.ttf')).toBe(true);
    expect(allow('/etc/passwd')).toBe(false);
    expect(allow(process.cwd() + '/package.json')).toBe(false);
  });
});

describe('PdfmakeRenderer — port seam', () => {
  it('satisfies the PdfRenderer port (structural, so DI binding stays valid)', () => {
    const asPort: PdfRenderer = new PdfmakeRenderer();
    expect(typeof asPort.render).toBe('function');
  });

  it('delegates render to createPdf().getBuffer() — no temp files, no policy changes', () => {
    pdfmake.createPdf.mockReset();
    const bytes = Buffer.from('%PDF-fake');
    const createPdf = jest.fn(() => ({ getBuffer: () => Promise.resolve(bytes) }));
    pdfmake.createPdf.mockImplementation(createPdf);
    // Fonts/policies register once per process at first construction (tested
    // above) — a render must not touch the process-wide policy seam again.
    const policyCallsBefore = pdfmake.setUrlAccessPolicy.mock.calls.length;

    const doc = { content: [{ text: 'hello' }] };
    const renderer = new PdfmakeRenderer();

    return expect(renderer.render(doc)).resolves.toBe(bytes).then(() => {
      expect(createPdf).toHaveBeenCalledWith(doc);
      expect(pdfmake.setUrlAccessPolicy.mock.calls).toHaveLength(
        policyCallsBefore,
      );
    });
  });
});

describe('PdfmakeRenderer — module binding', () => {
  it('is bound to the PDF_RENDERER token in ReportsModule (the only swap point)', () => {
    const providers = Reflect.getMetadata(
      'providers',
      ReportsModule,
    ) as { provide: unknown; useClass?: unknown }[];

    const binding = providers.find((p) => p.provide === PDF_RENDERER);
    expect(binding).toBeDefined();
    expect(binding?.useClass).toBe(PdfmakeRenderer);
  });
});