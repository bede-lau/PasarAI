import assert from "node:assert/strict";
import { test } from "node:test";

import {
  resolveTelegramBusinessDate,
  resolveTelegramOccurredAt,
} from "../src/telegram-business-date.js";

const deliveredAfterMidnight = "2026-07-16T18:12:00.000Z";

function kualaLumpurDate(value) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kuala_Lumpur",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(value));
}

test("undated Telegram messages use the configured reporting date", () => {
  assert.equal(resolveTelegramBusinessDate({
    text: "I sold five nasi lemak biasa at RM5 each.",
    occurredAt: deliveredAfterMidnight,
    defaultBusinessDate: "2026-07-16",
  }), "2026-07-16");

  assert.equal(kualaLumpurDate(resolveTelegramOccurredAt({
    text: "I sold five nasi lemak biasa at RM5 each.",
    occurredAt: deliveredAfterMidnight,
    defaultBusinessDate: "2026-07-16",
  })), "2026-07-16");
});

test("natural-language and numeric dates override the reporting fallback", () => {
  const cases = [
    ["for July 16", "2026-07-16"],
    ["untuk 15 Julai", "2026-07-15"],
    ["on 14/07/2026", "2026-07-14"],
    ["2026\u5e747\u670813\u65e5", "2026-07-13"],
  ];

  for (const [text, expected] of cases) {
    assert.equal(resolveTelegramBusinessDate({
      text,
      occurredAt: deliveredAfterMidnight,
      defaultBusinessDate: "2026-07-16",
    }), expected);
  }
});
