import { canonicalSubscriberNumber, fitCompanyName, maskPhone } from './invite-sms-text';

// Story 21-1, decision 2026-11-11 (CAP-5): company name in the invite SMS.
describe('fitCompanyName', () => {
  it('keeps a plain English name unchanged', () => {
    expect(fitCompanyName('Jobzo Services')).toBe('Jobzo Services');
  });

  it('keeps a name of exactly 20 characters unchanged', () => {
    const name = 'Abcdefghijklmnopqrst';
    expect(name).toHaveLength(20);
    expect(fitCompanyName(name)).toBe(name);
  });

  it('cuts a 21-character name to 20 characters', () => {
    expect(fitCompanyName('Abcdefghijklmnopqrstu')).toBe(
      'Abcdefghijklmnopqrst',
    );
  });

  it('trims leading and trailing spaces before counting', () => {
    expect(fitCompanyName('   Jobzo Services   ')).toBe('Jobzo Services');
  });

  it('does not leave a trailing space when the cut lands on one', () => {
    // Character 20 is a space, so a plain cut would end in a space.
    expect(fitCompanyName('Abcdefghijklmnopqrs tuv')).toBe(
      'Abcdefghijklmnopqrs',
    );
  });

  it('transliterates a Devanagari company name and capitalises it', () => {
    expect(fitCompanyName('रवि सर्विस')).toBe('Ravi Sarvis');
  });

  it('keeps the English part of a mixed name and transliterates the rest', () => {
    expect(fitCompanyName('Acme रवि')).toBe('Acme Ravi');
  });

  it('turns a non-Devanagari Indic script into "your company"', () => {
    expect(fitCompanyName('தமிழ் நிறுவனம்')).toBe('your company');
  });

  it('turns a name with an emoji into "your company"', () => {
    expect(fitCompanyName('Acme 😀')).toBe('your company');
  });

  it('turns a name with an accented Latin letter into "your company"', () => {
    expect(fitCompanyName('José Traders')).toBe('your company');
  });

  it('turns an empty or blank name into "your company"', () => {
    expect(fitCompanyName('')).toBe('your company');
    expect(fitCompanyName('   ')).toBe('your company');
  });

  it('never returns more than 20 characters for any input', () => {
    const long = 'Abcdefghijklmnopqrstuvwxyz0123456789';
    expect(fitCompanyName(long).length).toBeLessThanOrEqual(20);
  });
});

describe('canonicalSubscriberNumber and maskPhone', () => {
  it.each([
    ['9876543210', '9876543210'],
    ['09876543210', '9876543210'],
    ['919876543210', '9876543210'],
    ['098765 43210', '9876543210'],
    ['000987654321', '987654321'],
  ])('canonicalises +91 %s to %s', (typed, expected) => {
    expect(canonicalSubscriberNumber('+91', typed)).toBe(expected);
  });

  it('keeps the typed digits when stripping would leave under 6 digits', () => {
    expect(canonicalSubscriberNumber('+91', '000000')).toBe('000000');
  });

  it('does not strip 91 for a non-Indian dial code', () => {
    expect(canonicalSubscriberNumber('+1', '919876543210')).toBe('919876543210');
  });

  it('masks without a negative repeat for a very short number', () => {
    expect(() => maskPhone('+91', '123')).not.toThrow();
    expect(maskPhone('+91', '123')).toBe('+91 123');
  });
});
