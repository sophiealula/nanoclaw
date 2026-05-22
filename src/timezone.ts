/**
 * Check whether a timezone string is a valid IANA identifier
 * that Intl.DateTimeFormat can use.
 */
export function isValidTimezone(tz: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Return the given timezone if valid IANA, otherwise fall back to UTC.
 */
export function resolveTimezone(tz: string): string {
  return isValidTimezone(tz) ? tz : 'UTC';
}

/**
 * Convert a UTC ISO timestamp to a localized display string.
 * Uses the Intl API (no external dependencies).
 * Falls back to UTC if the timezone is invalid.
 */
export function formatLocalTime(utcIso: string, timezone: string): string {
  const date = new Date(utcIso);
  return date.toLocaleString('en-US', {
    timeZone: resolveTimezone(timezone),
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

/**
 * Return today's date with day-of-week in the given timezone.
 * Example: "Friday, May 22, 2026".
 * Used by the context header so the agent doesn't have to compute
 * day-of-week from a bare date (which it occasionally gets wrong).
 */
export function formatTodayInTimezone(timezone: string, now: Date = new Date()): string {
  return now.toLocaleDateString('en-US', {
    timeZone: resolveTimezone(timezone),
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}
