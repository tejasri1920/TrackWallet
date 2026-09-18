/**
 * Local-time ISO-8601 with seconds and no timezone suffix, e.g. `2026-08-26T20:23:00`.
 * Deliberately not UTC: the user has one timezone and the calendar view groups by local day.
 */
export function localIso(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  );
}
