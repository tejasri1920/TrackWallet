import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CsvError, parseCsv } from '../src/import/csv';
import { sha256Hex } from '../src/import/hash';
import { formatFixed2, formatMinorUnits, parseMinorUnits } from '../src/import/money';
import {
  ImportFatalError,
  HEADER,
  normalizeTimestamp,
  pairTransfers,
  parseTrackWallet,
  type SourceRow,
} from '../src/import/trackwallet';

const H = HEADER.join(',');
const file = (...lines: string[]) => [H, ...lines].join('\n') + '\n';

describe('parseMinorUnits', () => {
  it('parses unpadded decimals without floats', () => {
    expect(parseMinorUnits('-5.79')).toBe(-579);
    expect(parseMinorUnits('650')).toBe(65000);
    expect(parseMinorUnits('-547.60')).toBe(-54760);
    expect(parseMinorUnits('-5.7')).toBe(-570); // fractional part is padded, not scaled wrongly
    expect(parseMinorUnits('0.05')).toBe(5);
    expect(parseMinorUnits('-10.10')).toBe(-1010);
    expect(parseMinorUnits('9999999999999.99')).toBe(999999999999999);
  });

  it('never returns negative zero', () => {
    expect(Object.is(parseMinorUnits('-0'), 0)).toBe(true);
    expect(Object.is(parseMinorUnits('-0.00'), 0)).toBe(true);
  });

  it('rejects anything ambiguous', () => {
    for (const bad of ['', '+5', '.5', '5.', '1,000', '1e3', ' 5', '5 ', '1.234', '--5', '-', 'abc', '5.5.5', '$5', '99999999999999.99']) {
      expect(() => parseMinorUnits(bad), JSON.stringify(bad)).toThrow();
    }
  });

  it('classic float traps stay exact', () => {
    expect(parseMinorUnits('0.1') + parseMinorUnits('0.2')).toBe(30); // 0.1 + 0.2 !== 0.3 in floats
    expect(parseMinorUnits('1.15')).toBe(115); // 1.15 * 100 === 114.99999999999999 in floats
    expect(parseMinorUnits('8.2')).toBe(820);
  });
});

describe('formatMinorUnits / formatFixed2', () => {
  it("matches TrackWallet's style", () => {
    expect(formatMinorUnits(65000)).toBe('650');
    expect(formatMinorUnits(-54760)).toBe('-547.60');
    expect(formatMinorUnits(-1010)).toBe('-10.10');
    expect(formatMinorUnits(-1500)).toBe('-15');
    expect(formatMinorUnits(5)).toBe('0.05');
    expect(formatMinorUnits(-5)).toBe('-0.05');
    expect(formatMinorUnits(0)).toBe('0');
    expect(formatFixed2(-1500)).toBe('-15.00');
    expect(formatFixed2(5)).toBe('0.05');
  });

  it('refuses non-integers', () => {
    expect(() => formatMinorUnits(1.5)).toThrow();
    expect(() => formatFixed2(0.1)).toThrow();
  });

  it('round-trips 5,000 random amounts', () => {
    let seed = 12345;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff);
    for (let i = 0; i < 5000; i++) {
      const v = (rnd() % 2 ? -1 : 1) * (rnd() % 100_000_000);
      expect(parseMinorUnits(formatMinorUnits(v))).toBe(v);
      expect(parseMinorUnits(formatFixed2(v))).toBe(v);
    }
  });
});

describe('sha256Hex', () => {
  const ref = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

  it('matches node:crypto on known and edge-length inputs', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    for (const n of [1, 54, 55, 56, 57, 63, 64, 65, 119, 120, 128, 1000]) {
      const s = 'a'.repeat(n);
      expect(sha256Hex(s), `length ${n}`).toBe(ref(s));
    }
  });

  it('handles multi-byte characters', () => {
    for (const s of ['é', '€', '😀', 'Vantil’s', 'नमस्ते', 'x😀y€é'.repeat(20)]) {
      expect(sha256Hex(s), s).toBe(ref(s));
    }
  });

  it('matches node:crypto on 300 pseudo-random strings', () => {
    let seed = 99;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff);
    for (let i = 0; i < 300; i++) {
      const s = Array.from({ length: rnd() % 200 }, () => String.fromCharCode(32 + (rnd() % 95))).join('');
      expect(sha256Hex(s)).toBe(ref(s));
    }
  });
});

describe('parseCsv', () => {
  it('reads quoted and bare-empty fields alike', () => {
    const [r] = parseCsv('"a","b",,"",c\n');
    expect(r.fields).toEqual(['a', 'b', '', '', 'c']);
  });

  it('treats the TrackWallet transfer quirk (bare ,,) and quoted empties the same', () => {
    const [bare] = parseCsv('"t","Transfer","Cash","USD","-5","-5",,,""');
    const [quoted] = parseCsv('"t","Transfer","Cash","USD","-5","-5","","",""');
    expect(bare.fields).toEqual(quoted.fields);
    expect(bare.fields).toHaveLength(9);
  });

  it('handles CRLF, a BOM, a missing final newline, and blank lines', () => {
    const recs = parseCsv('﻿a,b\r\n\r\n"c","d"\r\n\r\ne,f');
    expect(recs.map((r) => r.fields)).toEqual([['a', 'b'], ['c', 'd'], ['e', 'f']]);
    expect(recs.map((r) => r.raw)).toEqual(['a,b', '"c","d"', 'e,f']);
    expect(recs.map((r) => r.line)).toEqual([1, 3, 5]);
  });

  it('handles commas, doubled quotes and newlines inside quoted fields', () => {
    const [r, next] = parseCsv('"a,b","say ""hi""","line1\nline2"\nx,y,z\n');
    expect(r.fields).toEqual(['a,b', 'say "hi"', 'line1\nline2']);
    expect(r.raw).toBe('"a,b","say ""hi""","line1\nline2"');
    expect(next.fields).toEqual(['x', 'y', 'z']);
    expect(next.line).toBe(3); // the embedded newline counts as a physical line
  });

  it('fails loudly on malformed input', () => {
    expect(() => parseCsv('"unterminated')).toThrow(CsvError);
    expect(() => parseCsv('"a"x,b')).toThrow(/after closing quote/);
  });
});

describe('normalizeTimestamp', () => {
  it('accepts both formats and always returns seconds', () => {
    expect(normalizeTimestamp('2026-08-26T20:23')).toBe('2026-08-26T20:23:00');
    expect(normalizeTimestamp('2026-08-29T19:14:13')).toBe('2026-08-29T19:14:13');
    expect(normalizeTimestamp('2028-02-29T00:00')).toBe('2028-02-29T00:00:00'); // leap year
  });

  it('rejects malformed and impossible values', () => {
    for (const bad of ['2026-08-26 20:23', '2026-13-01T00:00', '2026-02-29T10:00', '2026-04-31T10:00', '2026-08-01T24:00', '2026-08-01T10:60', '2026-08-01T10:00:60', '2026-8-1T10:00', '2026-08-01T10:00Z', '']) {
      expect(() => normalizeTimestamp(bad), bad).toThrow();
    }
  });
});

describe('parseTrackWallet', () => {
  const ok = '"2026-08-26T20:23","Expense","Credit","USD","-105.88","-105.88","Food & Drinks","Groceries","Costco"';

  it('parses a valid row and keeps the source sign', () => {
    const { rows, issues } = parseTrackWallet(file(ok));
    expect(issues).toEqual([]);
    expect(rows[0]).toMatchObject({
      line: 2, occurredAt: '2026-08-26T20:23:00', type: 'expense', account: 'Credit', currency: 'USD',
      amountNative: -10588, amountUsd: -10588, category: 'Food & Drinks', subcategory: 'Groceries', note: 'Costco',
    });
    expect(rows[0].raw).toBe(ok);
  });

  it('rejects a wrong header and an empty file', () => {
    expect(() => parseTrackWallet('Date,Type\n')).toThrow(ImportFatalError);
    expect(() => parseTrackWallet('')).toThrow(ImportFatalError);
    expect(() => parseTrackWallet(H.replace('Note', 'Memo') + '\n')).toThrow(/unexpected header/);
  });

  it('turns malformed CSV into a fatal error, not a crash', () => {
    expect(() => parseTrackWallet(H + '\n"oops')).toThrow(ImportFatalError);
  });

  it('asserts (never applies) the sign against the type', () => {
    const { rows, issues } = parseTrackWallet(
      file(
        '"2026-08-01T10:00","Expense","Cash","USD","5","5","Leisure","",""',
        '"2026-08-01T10:00","Income","Cash","USD","-5","-5","Salary","",""',
      ),
    );
    expect(rows).toEqual([]);
    expect(issues.map((i) => i.message)).toEqual([
      expect.stringContaining('Expense must be negative'),
      expect.stringContaining('Income must be positive'),
    ]);
  });

  it('flags every kind of bad row, one issue per record, and never drops one', () => {
    const lines = [
      '"2026-08-01T10:00","Expense","Cash","INR","-5","-0.06","Leisure","",""', // non-USD
      '"2026-08-01T10:00","Expense","Cash","USD","-5","-6","Leisure","",""', // Amount != Amount_USD
      '"2026-08-01T10:00","Expense","Cash","USD","-5.123","-5.123","Leisure","",""', // 3 decimals
      '"2026-08-01T10:00","Expense","Cash","USD","-5","-5","","",""', // no category
      '"2026-08-01T10:00","Transfer","Cash","USD","-5","-5","Leisure","",""', // transfer with category
      '"2026-08-01T10:00","Refund","Cash","USD","5","5","Leisure","",""', // unknown type
      '"2026-08-01T10:00","Expense","Cash","USD","0","0","Leisure","",""', // zero
      '"2026-08-01T10:00","Expense","","USD","-5","-5","Leisure","",""', // no account
      '"2026-08-01T10:00","Expense","Cash","USD","-5"', // wrong field count
      '"not-a-date","Expense","Cash","USD","-5","-5","Leisure","",""', // bad date
      ok, // and one good row
    ];
    const { rows, issues } = parseTrackWallet(file(...lines));
    expect(rows).toHaveLength(1);
    expect(issues).toHaveLength(10);
    expect(rows.length + issues.length).toBe(lines.length);
    expect(issues.map((i) => i.line)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(issues[0].message).toMatch(/not supported yet \(USD only\)/);
    expect(issues[2].message).toMatch(/more than 2 fractional digits/);
  });

  it('accepts bare empties on transfer rows', () => {
    const { rows, issues } = parseTrackWallet(file('"2026-08-25T15:51:06","Transfer","Chase Bank Account","USD","-1000","-1000",,,""'));
    expect(issues).toEqual([]);
    expect(rows[0]).toMatchObject({ type: 'transfer', category: '', subcategory: '', note: '', amountNative: -100000 });
  });
});

describe('pairTransfers', () => {
  let line = 1;
  const row = (occurredAt: string, account: string, cents: number): SourceRow => ({
    line: ++line, raw: `r${line}`, occurredAt, type: 'transfer', account, currency: 'USD',
    amountNative: cents, amountUsd: cents, category: '', subcategory: '', note: '',
  });
  const T = '2026-08-25T15:51:06';

  it('pairs a negative with the positive of equal size on another account, in either order', () => {
    const a = row(T, 'Chase', -100000), b = row(T, 'Credit', 100000);
    for (const input of [[a, b], [b, a]]) {
      const { pairs, unpaired } = pairTransfers(input);
      expect(unpaired).toEqual([]);
      expect(pairs).toEqual([{ negative: a, positive: b }]);
    }
  });

  it('does not pair across different timestamps', () => {
    const { pairs, unpaired } = pairTransfers([row(T, 'Chase', -500), row('2026-08-25T15:51:07', 'Credit', 500)]);
    expect(pairs).toEqual([]);
    expect(unpaired).toHaveLength(2);
  });

  it('leaves an odd group unpaired instead of inventing a counter-leg', () => {
    const { pairs, unpaired } = pairTransfers([row(T, 'Chase', -500)]);
    expect(pairs).toEqual([]);
    expect(unpaired[0].reason).toMatch(/odd number/);
  });

  it('refuses a positive and negative of different size', () => {
    const { pairs, unpaired } = pairTransfers([row(T, 'Chase', -500), row(T, 'Credit', 400)]);
    expect(pairs).toEqual([]);
    expect(unpaired).toHaveLength(2);
    expect(unpaired[0].reason).toMatch(/no counter-leg/);
  });

  it('refuses two legs on the same account', () => {
    const { pairs, unpaired } = pairTransfers([row(T, 'Chase', -500), row(T, 'Chase', 500)]);
    expect(pairs).toEqual([]);
    expect(unpaired).toHaveLength(2);
  });

  it('pairs independent transfers that share a timestamp when the sizes differ', () => {
    const a = row(T, 'Chase', -500), b = row(T, 'Credit', 500), c = row(T, 'Cash', -70), d = row(T, 'Chase', 70);
    const { pairs, unpaired } = pairTransfers([a, c, d, b]);
    expect(unpaired).toEqual([]);
    expect(pairs).toEqual(expect.arrayContaining([{ negative: a, positive: b }, { negative: c, positive: d }]));
    expect(pairs).toHaveLength(2);
  });

  it('refuses to guess when a pairing is ambiguous (same sizes, different accounts)', () => {
    const rows = [row(T, 'Chase', -500), row(T, 'Cash', -500), row(T, 'Credit', 500), row(T, 'Splitwise', 500)];
    const { pairs, unpaired } = pairTransfers(rows);
    expect(pairs).toEqual([]);
    expect(unpaired).toHaveLength(4);
    expect(unpaired[0].reason).toMatch(/ambiguous/);
  });

  it('is not ambiguous when the candidate counter-legs are interchangeable (same account)', () => {
    const rows = [row(T, 'Chase', -500), row(T, 'Chase', -500), row(T, 'Credit', 500), row(T, 'Credit', 500)];
    const { pairs, unpaired } = pairTransfers(rows);
    expect(unpaired).toEqual([]);
    expect(pairs).toHaveLength(2);
  });

  it('fails the WHOLE timestamp group when any pair in it fails, and only that group', () => {
    const good = [row('2026-08-01T10:00:00', 'Chase', -100), row('2026-08-01T10:00:00', 'Credit', 100)];
    const bad = [row(T, 'Chase', -500), row(T, 'Credit', 500), row(T, 'Cash', -30), row(T, 'Chase', 31)];
    const { pairs, unpaired } = pairTransfers([...good, ...bad]);
    expect(pairs).toHaveLength(1);
    expect(unpaired.map((u) => u.row)).toEqual(bad);
  });
});
