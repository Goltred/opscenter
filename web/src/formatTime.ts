/** Display times in 24-hour clock everywhere in the panel. */

const DATE_TIME: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
};

const DATE_TIME_WEEKDAY: Intl.DateTimeFormatOptions = {
  weekday: "short",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
};

const DATE_TIME_COMPACT: Intl.DateTimeFormatOptions = {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
};

const TIME: Intl.DateTimeFormatOptions = {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
};

const TIME_WITH_SECONDS: Intl.DateTimeFormatOptions = {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
};

function asDate(input: string | number | Date): Date | null {
  const d = input instanceof Date ? input : new Date(input);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Full local date + time, e.g. "Jul 24, 2026, 14:05". */
export function formatDateTime(input: string | number | Date): string {
  const d = asDate(input);
  return d ? d.toLocaleString(undefined, DATE_TIME) : "";
}

/** Weekday + date + time for schedule banners, e.g. "Fri, Jul 24, 14:05". */
export function formatDateTimeWeekday(input: string | number | Date): string {
  const d = asDate(input);
  return d ? d.toLocaleString(undefined, DATE_TIME_WEEKDAY) : "";
}

/** Compact date + time, e.g. "Jul 24, 14:05". */
export function formatDateTimeCompact(input: string | number | Date): string {
  const d = asDate(input);
  return d ? d.toLocaleString(undefined, DATE_TIME_COMPACT) : "";
}

/** Time only, e.g. "14:05". */
export function formatTime(input: string | number | Date): string {
  const d = asDate(input);
  return d ? d.toLocaleTimeString(undefined, TIME) : "";
}

/** Time with seconds, e.g. "14:05:09". */
export function formatTimeWithSeconds(input: string | number | Date): string {
  const d = asDate(input);
  return d ? d.toLocaleTimeString(undefined, TIME_WITH_SECONDS) : "";
}
