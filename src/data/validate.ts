import { MAX_CENTS } from '../db/limits';
import { invalid } from './errors';

export { MAX_CENTS };

const MAX_NAME = 100;
const MAX_TEXT = 1000;
/** Characters that print nothing: a name made only of these would look empty on screen. */
function isInvisible(cp: number): boolean {
  return (
    (cp >= 0x200b && cp <= 0x200f) || // zero-width space/joiners, direction marks
    (cp >= 0x2028 && cp <= 0x202e) || // line/paragraph separators, embeddings
    (cp >= 0x2060 && cp <= 0x206f) || // word joiner, invisible operators, deprecated formatting
    (cp >= 0xfe00 && cp <= 0xfe0f) || // variation selectors
    cp === 0xfeff || cp === 0x00ad || cp === 0x061c || cp === 0x034f || cp === 0x180e ||
    cp === 0x115f || cp === 0x1160 || cp === 0x3164 || cp === 0xffa0 || // Hangul fillers
    cp === 0x17b4 || cp === 0x17b5 || // Khmer inherent vowels
    cp === 0x2800 // braille blank
  );
}

/** A required display name: trimmed, visible, not absurdly long. */
export function cleanName(value: unknown, label: string): string {
  if (typeof value !== 'string') throw invalid(`${label} is required`);
  const name = value.trim();
  if (name === '') throw invalid(`${label} cannot be empty`);
  if (name.length > MAX_NAME) throw invalid(`${label} is too long (max ${MAX_NAME} characters)`);
  if ([...name].every((ch) => /\s/.test(ch) || isInvisible(ch.codePointAt(0) as number))) {
    throw invalid(`${label} must contain at least one visible character`);
  }
  return name;
}

/** Optional free text: trimmed; empty becomes null. */
export function cleanText(value: string | null | undefined, label: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw invalid(`${label} must be text`);
  const text = value.trim();
  if (text.length > MAX_TEXT) throw invalid(`${label} is too long (max ${MAX_TEXT} characters)`);
  return text === '' ? null : text;
}

/** Money in minor units must be a whole number of cents (never a float) within a sane range. */
export function assertCents(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw invalid(`${label} must be a whole number of cents`);
  }
  if (Math.abs(value) > MAX_CENTS) throw invalid(`${label} is too large (the limit is ${MAX_CENTS / 100} dollars)`);
  return value;
}

export function assertPositiveCents(value: unknown, label: string): number {
  const cents = assertCents(value, label);
  if (cents <= 0) throw invalid(`${label} must be greater than zero`);
  return cents;
}

/** An optional patch field must not be `null` when the field cannot be cleared. */
export function notNull<T>(value: T | null | undefined, label: string): T | undefined {
  if (value === null) throw invalid(`${label} cannot be cleared`);
  return value;
}
