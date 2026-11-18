/**
 * Timezone utilities strictly anchored to Asia/Tashkent (UTC+5, no DST).
 */
export const TASHKENT_TZ = 'Asia/Tashkent';
export const TASHKENT_OFFSET_MS = 5 * 60 * 60 * 1000;

export interface TashkentParts {
  year: number;
  month: number; // 1..12
  day: number; // 1..31
  hour: number;
  minute: number;
  second: number;
}

/** Returns calendar components in Asia/Tashkent (UTC+5). */
export function getTashkentParts(date: Date = new Date()): TashkentParts {
  const shifted = new Date(date.getTime() + TASHKENT_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    second: shifted.getUTCSeconds(),
  };
}

/** Creates a UTC Date representing YYYY-MM-DD HH:mm:ss in Asia/Tashkent. */
export function fromTashkent(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
): Date {
  const utcMs = Date.UTC(year, month - 1, day, hour, minute, second) - TASHKENT_OFFSET_MS;
  return new Date(utcMs);
}

/** Start of day (00:00:00) in Asia/Tashkent. */
export function startOfTashkentDay(date: Date = new Date()): Date {
  const { year, month, day } = getTashkentParts(date);
  return fromTashkent(year, month, day, 0, 0, 0);
}

/** Start of calendar month (1st, 00:00:00) in Asia/Tashkent. */
export function startOfTashkentMonth(date: Date = new Date(), monthOffset = 0): Date {
  const { year, month } = getTashkentParts(date);
  const totalMonths = year * 12 + (month - 1) + monthOffset;
  const targetYear = Math.floor(totalMonths / 12);
  const targetMonth = (totalMonths % 12) + 1;
  return fromTashkent(targetYear, targetMonth, 1, 0, 0, 0);
}

/** Formats date as YYYY-MM-DD in Asia/Tashkent. */
export function toTashkentDateString(date: Date = new Date()): string {
  const { year, month, day } = getTashkentParts(date);
  const mm = String(month).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  return `${year}-${mm}-${dd}`;
}

/** Formats YYYY-MM in Asia/Tashkent. */
export function toTashkentMonthKey(date: Date = new Date()): string {
  const { year, month } = getTashkentParts(date);
  return `${year}-${String(month).padStart(2, '0')}`;
}

/** Days in a given calendar month (1..12). */
export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Adds N days to a Date. */
export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

/** Whole calendar days between two dates in Asia/Tashkent (b - a). */
export function diffTashkentDays(from: Date, to: Date): number {
  const a = startOfTashkentDay(from).getTime();
  const b = startOfTashkentDay(to).getTime();
  return Math.round((b - a) / (24 * 60 * 60 * 1000));
}
