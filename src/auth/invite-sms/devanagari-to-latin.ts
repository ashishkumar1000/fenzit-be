/**
 * Small Devanagari-to-English-letters table for the invite SMS first name
 * (spec-invite-sms-download-link CAP-4). It covers only what a first name
 * needs. No external transliteration library: the SMS must stay in plain
 * English letters so it fits one 160-character part.
 */

const VIRAMA = '्';
const NUKTA = '़';
const ANUSVARA = 'ं';
const CHANDRABINDU = 'ँ';
const VISARGA = 'ः';

const INDEPENDENT_VOWELS: Map<string, string> = new Map<string, string>([
  ['अ', 'a'],
  ['आ', 'aa'],
  ['इ', 'i'],
  ['ई', 'ee'],
  ['उ', 'u'],
  ['ऊ', 'oo'],
  ['ऋ', 'ri'],
  ['ए', 'e'],
  ['ऐ', 'ai'],
  ['ओ', 'o'],
  ['औ', 'au'],
]);

// Vowel signs (matras) replace the inherent "a" of the consonant before them.
const VOWEL_SIGNS: Map<string, string> = new Map<string, string>([
  ['ा', 'aa'],
  ['ि', 'i'],
  ['ी', 'ee'],
  ['ु', 'u'],
  ['ू', 'oo'],
  ['ृ', 'ri'],
  ['े', 'e'],
  ['ै', 'ai'],
  ['ो', 'o'],
  ['ौ', 'au'],
]);

const CONSONANTS: Map<string, string> = new Map<string, string>([
  ['क', 'k'],
  ['ख', 'kh'],
  ['ग', 'g'],
  ['घ', 'gh'],
  ['ङ', 'n'],
  ['च', 'ch'],
  ['छ', 'chh'],
  ['ज', 'j'],
  ['झ', 'jh'],
  ['ञ', 'n'],
  ['ट', 't'],
  ['ठ', 'th'],
  ['ड', 'd'],
  ['ढ', 'dh'],
  ['ण', 'n'],
  ['त', 't'],
  ['थ', 'th'],
  ['द', 'd'],
  ['ध', 'dh'],
  ['न', 'n'],
  ['प', 'p'],
  ['फ', 'ph'],
  ['ब', 'b'],
  ['भ', 'bh'],
  ['म', 'm'],
  ['य', 'y'],
  ['र', 'r'],
  ['ल', 'l'],
  ['व', 'v'],
  ['श', 'sh'],
  ['ष', 'sh'],
  ['स', 's'],
  ['ह', 'h'],
  // Nukta letters, keyed as base letter + nukta (the decomposed form).
  ['क़', 'q'],
  ['ख़', 'kh'],
  ['ग़', 'g'],
  ['ज़', 'z'],
  ['ड़', 'r'],
  ['ढ़', 'rh'],
  ['फ़', 'f'],
  ['य़', 'y'],
]);

/**
 * Converts Devanagari letters to English letters. Each consonant carries an
 * inherent "a" unless a vowel sign or a virama (halant) follows it. Any
 * character this table does not know is passed through unchanged, so the
 * caller can reject it.
 */
export function transliterateDevanagari(input: string): string {
  // NFD splits precomposed nukta letters into base letter + nukta, so one lookup covers both forms.
  const chars = Array.from(input.normalize('NFD'));
  let out = '';
  // True when the last consonant still owes its inherent "a".
  let owesInherentA = false;

  for (let i = 0; i < chars.length; i++) {
    let ch = chars[i];
    if (chars[i + 1] === NUKTA && CONSONANTS.has(ch + NUKTA)) {
      ch = ch + NUKTA;
      i++;
    }

    if (CONSONANTS.has(ch)) {
      if (owesInherentA) out += 'a';
      out += CONSONANTS.get(ch)!;
      owesInherentA = true;
    } else if (VOWEL_SIGNS.has(ch)) {
      out += VOWEL_SIGNS.get(ch)!;
      owesInherentA = false;
    } else if (INDEPENDENT_VOWELS.has(ch)) {
      if (owesInherentA) out += 'a';
      out += INDEPENDENT_VOWELS.get(ch)!;
      owesInherentA = false;
    } else if (ch === VIRAMA) {
      // The virama removes the inherent "a" of the consonant before it.
      owesInherentA = false;
    } else if (ch === ANUSVARA || ch === CHANDRABINDU) {
      if (owesInherentA) out += 'a';
      out += 'n';
      owesInherentA = false;
    } else if (ch === VISARGA) {
      if (owesInherentA) out += 'a';
      out += 'h';
      owesInherentA = false;
    } else {
      // Any other character (Latin, digit, emoji, other script) passes through.
      if (owesInherentA) out += 'a';
      out += ch;
      owesInherentA = false;
    }
  }

  // A word that ends on a consonant drops its inherent "a", as spoken Hindi does
  // (राम → Ram). The trailing owesInherentA is deliberately not emitted.
  return out;
}
