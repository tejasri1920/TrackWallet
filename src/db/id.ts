/** Random row id. React Native has no `crypto.randomUUID` by default: inject a generator there. */
export function newId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (!c?.randomUUID) {
    throw new Error('crypto.randomUUID is unavailable; pass an id generator (React Native: expo-crypto)');
  }
  return c.randomUUID();
}
