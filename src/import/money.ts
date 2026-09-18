/**
 * Money strings <-> signed integer minor units. Integer arithmetic only: no parseFloat,
 * no Number("1.5"), so a value can never pick up float error on the way in or out.
 */

const AMOUNT = /^(-)?(\d+)(?:\.(\d+))?$/;

/**
 * Parses an unpadded decimal string ("-5.79", "650", "-547.60", "-5.7") into minor units.
 * Throws on anything ambiguous: empty, "+5", ".5", "5.", "1,000", exponents, whitespace,
 * more than 2 fractional digits, or a magnitude beyond Number.MAX_SAFE_INTEGER.
 */
export function parseMinorUnits(input: string): number {
  const m = AMOUNT.exec(input);
  if (!m) throw new Error(`not a plain decimal amount: ${JSON.stringify(input)}`);
  const [, minus, whole, frac = ''] = m;
  if (frac.length > 2) throw new Error(`more than 2 fractional digits: ${JSON.stringify(input)}`);
  const magnitude = Number(whole) * 100 + Number(frac.padEnd(2, '0'));
  if (!Number.isSafeInteger(magnitude) || whole.length > 13) {
    throw new Error(`amount out of range: ${JSON.stringify(input)}`);
  }
  return minus && magnitude !== 0 ? -magnitude : magnitude; // never -0
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** TrackWallet's own style: whole amounts have no decimals ("650"), others have 2 ("-547.60"). */
export function formatMinorUnits(minor: number): string {
  if (!Number.isSafeInteger(minor)) throw new Error(`not an integer amount: ${minor}`);
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  const whole = Math.trunc(abs / 100);
  const frac = abs % 100;
  return frac === 0 ? `${sign}${whole}` : `${sign}${whole}.${pad2(frac)}`;
}

/** Always two decimals, for human-readable reports ("-15.00"). */
export function formatFixed2(minor: number): string {
  if (!Number.isSafeInteger(minor)) throw new Error(`not an integer amount: ${minor}`);
  const abs = Math.abs(minor);
  return `${minor < 0 ? '-' : ''}${Math.trunc(abs / 100)}.${pad2(abs % 100)}`;
}
