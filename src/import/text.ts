/** Lower-cases ASCII only, exactly like SQLite's COLLATE NOCASE, so plans and unique indexes agree. */
export const fold = (s: string): string => s.replace(/[A-Z]/g, (c) => c.toLowerCase());

/** Case-folded and trimmed: how names are compared when deciding two spellings are the same thing. */
export const foldTrim = (s: string): string => fold(s.trim());
