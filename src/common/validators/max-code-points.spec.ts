import {
  IsOptional,
  MaxLength,
  ValidationError,
  validate,
} from 'class-validator';
import { MaxCodePoints, codePointCount } from './max-code-points';

/** QA view of the shared character-limit validator. */
class CodePointProbe {
  @MaxCodePoints(5)
  value?: unknown;
}

class LengthProbe {
  @MaxLength(5)
  value?: unknown;
}

const errorsFor = async (
  Probe: new () => { value?: unknown },
  value: unknown,
): Promise<ValidationError[]> => {
  const probe = new Probe();
  probe.value = value;
  return validate(probe);
};

describe('MaxCodePoints (QA)', () => {
  describe('counting', () => {
    it('counts an emoji as one character, not two code units', () => {
      expect(codePointCount('😀')).toBe(1);
      expect('😀'.length).toBe(2);
    });

    it('counts each combining mark as its own code point (what the database counts)', () => {
      // "é" typed as e + combining acute is two code points.
      expect(codePointCount('é')).toBe(2);
    });

    it('counts a lone surrogate as one code point, so it cannot slip past the limit', () => {
      expect(codePointCount('\uD83D')).toBe(1);
    });

    it('counts zero for an empty string', () => {
      expect(codePointCount('')).toBe(0);
    });
  });

  describe('boundaries', () => {
    it('accepts exactly 5 emoji (5 characters, 10 code units)', async () => {
      expect(await errorsFor(CodePointProbe, '😀😀😀😀😀')).toHaveLength(0);
    });

    it('refuses 6 emoji', async () => {
      expect(await errorsFor(CodePointProbe, '😀😀😀😀😀😀')).toHaveLength(1);
    });

    it('accepts exactly 5 code points made of letters and combining marks', async () => {
      expect(await errorsFor(CodePointProbe, 'ááa')).toHaveLength(0);
    });

    it('refuses 6 code points made of letters and combining marks', async () => {
      expect(await errorsFor(CodePointProbe, 'ááá')).toHaveLength(1);
    });

    it('accepts an empty string', async () => {
      expect(await errorsFor(CodePointProbe, '')).toHaveLength(0);
    });
  });

  describe('same contract as MaxLength (parity)', () => {
    it.each([
      ['a non-string number', 123],
      ['null', null],
      ['undefined', undefined],
      ['an array', ['abc']],
      ['an object', { a: 1 }],
    ])('refuses %s just as MaxLength does', async (_label, value) => {
      const ours = await errorsFor(CodePointProbe, value);
      const theirs = await errorsFor(LengthProbe, value);
      expect(ours).toHaveLength(theirs.length);
      expect(ours.length).toBeGreaterThan(0);
    });

    it.each([0, 1, 4, 5, 6])(
      'agrees with MaxLength on ASCII text of %i characters',
      async (length) => {
        const text = 'x'.repeat(length);
        const ours = await errorsFor(CodePointProbe, text);
        const theirs = await errorsFor(LengthProbe, text);
        expect(ours.length).toBe(theirs.length);
      },
    );

    it('keeps the same default error text as MaxLength', async () => {
      const [ours] = await errorsFor(CodePointProbe, 'x'.repeat(6));
      const [theirs] = await errorsFor(LengthProbe, 'x'.repeat(6));
      expect(Object.values(ours.constraints ?? {})).toEqual([
        'value must be shorter than or equal to 5 characters',
      ]);
      expect(Object.values(theirs.constraints ?? {})).toEqual([
        'value must be shorter than or equal to 5 characters',
      ]);
    });

    it('does not fail an undecorated optional field (IsOptional still works)', async () => {
      class Optional {
        @IsOptional()
        @MaxCodePoints(5)
        value?: unknown;
      }
      const probe = new Optional();
      expect(await validate(probe)).toHaveLength(0);
    });
  });

  it('uses a custom message when the caller passes one', async () => {
    class Custom {
      @MaxCodePoints(2, { message: 'too long, sorry' })
      value?: unknown;
    }
    const probe = new Custom();
    probe.value = 'abc';
    const [error] = await validate(probe);
    expect(Object.values(error.constraints ?? {})).toEqual(['too long, sorry']);
  });
});
