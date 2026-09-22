/**
 * Fast token estimation.
 *
 * Deliberately not a full BPE tokenizer: routing and budget decisions need a
 * fast, monotonic, workload-stable estimate, not provider-exact counts. The
 * heuristic mirrors the one documented in the DSH token meter:
 *   - CJK characters: ~1 token each
 *   - other characters: ~3.5-4 chars per token
 *   - plus a small structural overhead per block
 */

/** Estimate token count for one text block. Never throws, always >= 0. */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  let cjk = 0;
  let other = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.codePointAt(i)!;
    if (i + 1 < text.length && c >= 0xd800 && c <= 0xdbff) i++; // surrogate pair
    if (isCjk(c)) cjk++;
    else other++;
  }
  const units = Math.round(cjk * 1.0 + other / 3.8);
  // structural overhead: newlines and indentation carry token cost
  let nl = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) nl++;
  return Math.max(1, units + Math.floor(nl / 4));
}

function isCjk(c: number): boolean {
  return (
    (c >= 0x4e00 && c <= 0x9fff) || // CJK unified
    (c >= 0x3400 && c <= 0x4dbf) || // ext A
    (c >= 0x3040 && c <= 0x30ff) || // kana
    (c >= 0xac00 && c <= 0xd7af) || // hangul
    (c >= 0xff00 && c <= 0xffef) // fullwidth forms
  );
}

/** Approximate word count (whitespace split, cheap). */
export function countWords(text: string): number {
  let words = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    const isSpace = c === 32 || c === 9 || c === 10 || c === 13 || c === 11 || c === 12;
    if (!isSpace) {
      if (!inWord) {
        words++;
        inWord = true;
      }
    } else {
      inWord = false;
    }
  }
  return words;
}
