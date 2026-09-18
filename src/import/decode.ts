import { ImportFatalError } from './trackwallet';

/**
 * Bytes of an export file -> text, strictly. A lossy decode would silently turn "José" into
 * "Jos�" in every note and person name, and verification would share the same blind spot.
 * A UTF-8 BOM is dropped; UTF-16 (which Excel can produce) is refused rather than misread.
 */
export function decodeCsvBytes(bytes: Uint8Array): string {
  const utf16 = bytes.length >= 2 && ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff));
  if (utf16) throw new ImportFatalError('the file is UTF-16 encoded; re-export or re-save it as UTF-8');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new ImportFatalError('the file is not valid UTF-8 (a lossy read would corrupt names); re-save it as UTF-8');
  }
}
