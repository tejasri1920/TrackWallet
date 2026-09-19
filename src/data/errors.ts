/**
 * Errors the data layer raises for things a user can fix. The UI can show `message` as is and
 * branch on `code`. Anything else (a SQLite error) means a bug or a corrupt database.
 */
export type DataErrorCode = 'invalid' | 'not_found' | 'conflict';

export class DataError extends Error {
  constructor(readonly code: DataErrorCode, message: string) {
    super(message);
    this.name = 'DataError';
  }
}

export const invalid = (message: string) => new DataError('invalid', message);
export const notFound = (message: string) => new DataError('not_found', message);
export const conflict = (message: string) => new DataError('conflict', message);
