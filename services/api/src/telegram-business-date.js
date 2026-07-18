const DEFAULT_TELEGRAM_BUSINESS_DATE = "2026-07-16";
const DEFAULT_TELEGRAM_TIME_ZONE = "Asia/Kuala_Lumpur";
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

const MONTH_NUMBERS = new Map([
  ["jan", 1],
  ["january", 1],
  ["januari", 1],
  ["feb", 2],
  ["february", 2],
  ["februari", 2],
  ["mar", 3],
  ["march", 3],
  ["mac", 3],
  ["apr", 4],
  ["april", 4],
  ["may", 5],
  ["mei", 5],
  ["jun", 6],
  ["june", 6],
  ["jul", 7],
  ["july", 7],
  ["julai", 7],
  ["aug", 8],
  ["august", 8],
  ["ogos", 8],
  ["sep", 9],
  ["sept", 9],
  ["september", 9],
  ["oct", 10],
  ["october", 10],
  ["oktober", 10],
  ["nov", 11],
  ["november", 11],
  ["dec", 12],
  ["december", 12],
  ["disember", 12],
]);

const MONTH_PATTERN = [...MONTH_NUMBERS.keys()]
  .sort((left, right) => right.length - left.length)
  .join("|");

function calendarDate(year, month, day) {
  const value = [
    String(year).padStart(4, "0"),
    String(month).padStart(2, "0"),
    String(day).padStart(2, "0"),
  ].join("-");
  if (!ISO_DATE_PATTERN.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(parsed.valueOf())
    || parsed.toISOString().slice(0, 10) !== value
    ? null
    : value;
}

function dateTimeParts(value, timeZone) {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return null;
  const parts = new Intl.DateTimeFormat("en", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  return Object.fromEntries(
    parts
      .filter(({ type }) => type !== "literal")
      .map(({ type, value: partValue }) => [type, Number(partValue)]),
  );
}

function dateInTimeZone(value, timeZone) {
  const parts = dateTimeParts(value, timeZone);
  return parts
    ? calendarDate(parts.year, parts.month, parts.day)
    : null;
}

function offsetAt(value, timeZone) {
  const parts = dateTimeParts(value, timeZone);
  if (!parts) return 0;
  return Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  ) - new Date(value).getTime();
}

function instantOnBusinessDate(date, occurredAt, timeZone) {
  const time = dateTimeParts(occurredAt, timeZone) ?? {
    hour: 12,
    minute: 0,
    second: 0,
  };
  const [year, month, day] = date.split("-").map(Number);
  const localTimestamp = Date.UTC(
    year,
    month - 1,
    day,
    time.hour,
    time.minute,
    time.second,
  );
  let offset = offsetAt(localTimestamp, timeZone);
  let instant = localTimestamp - offset;
  const refinedOffset = offsetAt(instant, timeZone);
  if (refinedOffset !== offset) {
    offset = refinedOffset;
    instant = localTimestamp - offset;
  }
  return new Date(instant).toISOString();
}

function explicitDate(text, fallbackYear) {
  if (typeof text !== "string" || !text.trim()) return null;

  const iso = /\b(20\d{2}-\d{2}-\d{2})\b/u.exec(text)?.[1];
  if (iso) {
    const [year, month, day] = iso.split("-").map(Number);
    return calendarDate(year, month, day);
  }

  const numeric = /\b(\d{1,2})[/-](\d{1,2})[/-](20\d{2})\b/u.exec(text);
  if (numeric) {
    return calendarDate(
      Number(numeric[3]),
      Number(numeric[2]),
      Number(numeric[1]),
    );
  }

  const chinese =
    /(?:(20\d{2})\s*\u5e74\s*)?(\d{1,2})\s*\u6708\s*(\d{1,2})\s*\u65e5?/u
      .exec(text);
  if (chinese) {
    return calendarDate(
      Number(chinese[1] ?? fallbackYear),
      Number(chinese[2]),
      Number(chinese[3]),
    );
  }

  const monthFirst = new RegExp(
    `\\b(${MONTH_PATTERN})\\s+(\\d{1,2})(?:st|nd|rd|th)?`
      + `(?:\\s*,?\\s*(20\\d{2}))?\\b`,
    "iu",
  ).exec(text);
  if (monthFirst) {
    return calendarDate(
      Number(monthFirst[3] ?? fallbackYear),
      MONTH_NUMBERS.get(monthFirst[1].toLowerCase()),
      Number(monthFirst[2]),
    );
  }

  const dayFirst = new RegExp(
    `\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH_PATTERN})`
      + `(?:\\s*,?\\s*(20\\d{2}))?\\b`,
    "iu",
  ).exec(text);
  if (dayFirst) {
    return calendarDate(
      Number(dayFirst[3] ?? fallbackYear),
      MONTH_NUMBERS.get(dayFirst[2].toLowerCase()),
      Number(dayFirst[1]),
    );
  }

  return null;
}

export function resolveTelegramBusinessDate({
  text,
  occurredAt,
  defaultBusinessDate = DEFAULT_TELEGRAM_BUSINESS_DATE,
  timeZone = DEFAULT_TELEGRAM_TIME_ZONE,
}) {
  const fallbackDate = calendarDate(
    ...String(defaultBusinessDate).split("-").map(Number),
  ) ?? dateInTimeZone(occurredAt, timeZone);
  if (!fallbackDate) return null;
  return explicitDate(text, Number(fallbackDate.slice(0, 4))) ?? fallbackDate;
}

export function resolveTelegramOccurredAt({
  text,
  occurredAt,
  defaultBusinessDate = DEFAULT_TELEGRAM_BUSINESS_DATE,
  timeZone = DEFAULT_TELEGRAM_TIME_ZONE,
}) {
  const businessDate = resolveTelegramBusinessDate({
    text,
    occurredAt,
    defaultBusinessDate,
    timeZone,
  });
  return businessDate
    ? instantOnBusinessDate(businessDate, occurredAt, timeZone)
    : new Date(occurredAt).toISOString();
}
