// All hackathon sessions run on India time. India has no daylight saving,
// so a fixed +05:30 offset is exact and avoids depending on the server's TZ.
export const IST_OFFSET_MIN = 330;
const DAY_MS = 86_400_000;

/** "YYYY-MM-DD" of the given instant in IST. */
export function istDate(input) {
  const d = new Date(new Date(input).getTime() + IST_OFFSET_MIN * 60_000);
  return d.toISOString().slice(0, 10);
}

/** "HH:MM" of the given instant in IST. */
export function istTime(input) {
  const d = new Date(new Date(input).getTime() + IST_OFFSET_MIN * 60_000);
  return d.toISOString().slice(11, 16);
}

/** Day of week (0 = Sunday) of a "YYYY-MM-DD" date string. */
export function weekday(dateStr) {
  return new Date(dateStr + "T00:00:00Z").getUTCDay();
}

export function addDays(dateStr, days) {
  const d = new Date(dateStr + "T00:00:00Z");
  return new Date(d.getTime() + days * DAY_MS).toISOString().slice(0, 10);
}

export function daysBetween(fromDateStr, toDateStr) {
  return Math.round((new Date(toDateStr + "T00:00:00Z") - new Date(fromDateStr + "T00:00:00Z")) / DAY_MS);
}

/** Today's date in IST. */
export function todayIst(now = new Date()) {
  return istDate(now);
}

/** Instant (Date) for an IST date + "HH:MM". */
export function istInstant(dateStr, hhmm = "00:00") {
  return new Date(`${dateStr}T${hhmm}:00+05:30`);
}

export const DAY_CODES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function fmtShortDate(dateStr) {
  const d = new Date(dateStr + "T00:00:00Z");
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}
