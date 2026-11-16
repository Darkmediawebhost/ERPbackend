export const DEFAULT_TIMEZONE = 'Asia/Kolkata';

export function assertTimeZone(timeZone) {
  Intl.DateTimeFormat('en-US', { timeZone });
  return timeZone;
}

export function ymdInTimeZone(date, timeZone = DEFAULT_TIMEZONE) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

export function hmInTimeZone(date, timeZone = DEFAULT_TIMEZONE) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const hour = parts.find((part) => part.type === 'hour')?.value ?? '00';
  const minute = parts.find((part) => part.type === 'minute')?.value ?? '00';
  return `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`;
}

export function parseYmd(ymd) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || ''));
  if (!match) throw new Error('Date must be YYYY-MM-DD');
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  if (m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) throw new Error('Invalid date');
  return { y, m, d };
}

export function formatYmd({ y, m, d }) {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function addDays(ymd, days) {
  const { y, m, d } = parseYmd(ymd);
  const next = new Date(Date.UTC(y, m - 1, d + days));
  return formatYmd({ y: next.getUTCFullYear(), m: next.getUTCMonth() + 1, d: next.getUTCDate() });
}

export function addMonths(ymd, count) {
  const { y, m, d } = parseYmd(ymd);
  const total = y * 12 + (m - 1) + count;
  const year = Math.floor(total / 12);
  const month = (total % 12) + 1;
  return formatYmd({ y: year, m: month, d: Math.min(d, daysInMonth(year, month)) });
}

export function monthStart(ymd) {
  const { y, m } = parseYmd(ymd);
  return formatYmd({ y, m, d: 1 });
}

export function monthEnd(ymd) {
  const { y, m } = parseYmd(ymd);
  return formatYmd({ y, m, d: daysInMonth(y, m) });
}

export function todayKey(timeZone = DEFAULT_TIMEZONE) {
  return ymdInTimeZone(new Date(), timeZone);
}

export function weekdayIndex(ymd) {
  const { y, m, d } = parseYmd(ymd);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function dateFromKey(ymd) {
  parseYmd(ymd);
  return new Date(`${ymd}T12:00:00+05:30`);
}

export function eachDate(from, to) {
  const dates = [];
  let cursor = from;
  while (cursor <= to && dates.length < 400) {
    dates.push(cursor);
    cursor = addDays(cursor, 1);
  }
  return dates;
}

export function eachMonth(from, to) {
  const months = [];
  let cursor = monthStart(from);
  const end = monthStart(to);
  while (cursor <= end && months.length < 60) {
    months.push(cursor.slice(0, 7));
    cursor = addMonths(cursor, 1);
  }
  return months;
}

export function previousWindow(from, to) {
  const start = Date.UTC(...Object.values(parseYmd(from)).map((value, index) => (index === 1 ? value - 1 : value)));
  const end = Date.UTC(...Object.values(parseYmd(to)).map((value, index) => (index === 1 ? value - 1 : value)));
  const days = Math.round((end - start) / 86400000) + 1;
  const previousTo = addDays(from, -1);
  return { from: addDays(previousTo, -(days - 1)), to: previousTo };
}

export function resolvePreset(preset, timeZone = DEFAULT_TIMEZONE, financialYearStartMonth = 4, from, to) {
  const today = todayKey(timeZone);
  const { y, m } = parseYmd(today);
  switch (preset) {
    case 'today':
      return { from: today, to: today, label: 'Today' };
    case 'this_week': {
      const weekday = weekdayIndex(today);
      const mondayOffset = weekday === 0 ? 6 : weekday - 1;
      return { from: addDays(today, -mondayOffset), to: today, label: 'This week' };
    }
    case 'this_month':
      return { from: monthStart(today), to: today, label: 'This month' };
    case 'last_month': {
      const previous = addMonths(monthStart(today), -1);
      return { from: monthStart(previous), to: monthEnd(previous), label: 'Last month' };
    }
    case 'this_quarter': {
      const quarterStartMonth = Math.floor((m - 1) / 3) * 3 + 1;
      return { from: formatYmd({ y, m: quarterStartMonth, d: 1 }), to: today, label: 'This quarter' };
    }
    case 'this_year': {
      const startMonth = financialYearStartMonth || 4;
      const startYear = m >= startMonth ? y : y - 1;
      return { from: formatYmd({ y: startYear, m: startMonth, d: 1 }), to: today, label: 'This year' };
    }
    case 'custom': {
      if (!from || !to) throw new Error('Custom range needs a start and end date');
      parseYmd(from);
      parseYmd(to);
      if (from > to) throw new Error('Start date must be on or before the end date');
      return { from, to, label: 'Custom range' };
    }
    default:
      throw new Error('Unknown date range');
  }
}

export function rangeFromQuery(query, settings = {}) {
  const timeZone = settings.timezone || DEFAULT_TIMEZONE;
  const startMonth = settings.financialYearStartMonth || 4;
  if (query.from || query.to) {
    return { ...resolvePreset('custom', timeZone, startMonth, query.from, query.to), preset: 'custom' };
  }
  const preset = query.preset || 'this_month';
  return { ...resolvePreset(preset, timeZone, startMonth), preset };
}

export function isLate(date, workStart = '10:00', graceMinutes = 0, timeZone = DEFAULT_TIMEZONE) {
  const [hour, minute] = hmInTimeZone(date, timeZone).split(':').map(Number);
  const [startHour, startMinute] = String(workStart).split(':').map(Number);
  return hour * 60 + minute > startHour * 60 + startMinute + Number(graceMinutes || 0);
}

export function rangesOverlap(startA, endA, startB, endB) {
  return startA <= endB && startB <= endA;
}
