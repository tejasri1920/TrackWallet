/**
 * Largest amount (or balance) accepted anywhere: $10,000,000,000.00, in cents.
 * One limit, shared by manual entry, the importer and the transfer write path, so a row that can
 * be written can always be edited or deleted later, and sums stay well inside a JS number.
 */
export const MAX_CENTS = 1_000_000_000_000;
