import { fitCompanyName } from './invite-sms-text';

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
