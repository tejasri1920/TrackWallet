/** Minimal RFC-4180 CSV reader. Keeps each record's original text so reports can show it in full. */

export interface CsvRecord {
  /** 1-based physical line the record starts on. */
  line: number;
  fields: string[];
  /** The record exactly as it appears in the source, without its line terminator. */
  raw: string;
}

export class CsvError extends Error {
  constructor(message: string, readonly line: number) {
    super(`line ${line}: ${message}`);
  }
}

/**
 * Handles: a UTF-8 BOM, CRLF or LF, quoted fields (commas, doubled quotes, newlines inside),
 * bare empty fields (`,,`) and quoted empties (`"",""`) alike, and blank lines (skipped).
 * Throws CsvError on an unterminated quote or junk after a closing quote.
 */
export function parseCsv(text: string): CsvRecord[] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const records: CsvRecord[] = [];
  let i = 0;
  let line = 1;
  const n = src.length;

  while (i < n) {
    const start = i;
    const startLine = line;
    const fields: string[] = [];
    let field = '';
    let end = -1; // index where the record's text ends (before the terminator)

    for (;;) {
      if (i < n && src[i] === '"') {
        i++; // opening quote
        for (;;) {
          if (i >= n) throw new CsvError('unterminated quoted field', startLine);
          const ch = src[i];
          if (ch === '"') {
            if (src[i + 1] === '"') { field += '"'; i += 2; continue; }
            i++; // closing quote
            break;
          }
          if (ch === '\n') line++;
          field += ch;
          i++;
        }
        if (i < n && src[i] !== ',' && src[i] !== '\n' && src[i] !== '\r') {
          throw new CsvError(`unexpected character ${JSON.stringify(src[i])} after closing quote`, line);
        }
      } else {
        while (i < n && src[i] !== ',' && src[i] !== '\n' && src[i] !== '\r') field += src[i++];
      }
      fields.push(field);
      field = '';

      if (i < n && src[i] === ',') { i++; continue; }
      end = i;
      if (src[i] === '\r') { i++; if (src[i] === '\n') i++; line++; } // CRLF, or a lone CR
      else if (src[i] === '\n') { i++; line++; }
      break;
    }

    const raw = src.slice(start, end);
    if (raw.trim() === '' && fields.length === 1 && fields[0] === '') continue; // blank line
    records.push({ line: startLine, fields, raw });
  }
  return records;
}
