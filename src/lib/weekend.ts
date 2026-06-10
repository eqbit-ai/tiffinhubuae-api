// Centralized weekend-skip logic.
//
// Delivery dates in this app are stored as plain "YYYY-MM-DD" strings, which
// represent a calendar day with no time or zone. The weekday must therefore be
// derived from the calendar date itself — NOT via the server's local clock
// (Railway runs in UTC), which previously caused the computed day-of-week to
// drift for merchants in other timezones and let weekend deliveries slip
// through. 0 = Sunday, 6 = Saturday.

/** Weekday (0=Sun … 6=Sat) of a "YYYY-MM-DD" calendar date, timezone-independent. Null if unparseable. */
export function weekdayOfDateStr(dateStr: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateStr);
  if (!m) return null;
  const [, y, mo, d] = m;
  return new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d))).getUTCDay();
}

/** True when the given "YYYY-MM-DD" (or ISO) date falls on Saturday or Sunday. */
export function isWeekendDate(dateStr: string | null | undefined): boolean {
  if (!dateStr) return false;
  const day = weekdayOfDateStr(dateStr);
  return day === 0 || day === 6;
}

/** Today's calendar date as "YYYY-MM-DD" in the merchant's timezone (defaults to UTC). */
export function todayInTimezone(timezone?: string | null): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone || 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
  } catch {
    // Invalid timezone string → fall back to UTC.
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
  }
}
