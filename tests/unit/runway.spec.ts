import { test, expect } from "@playwright/test";
import { runway, runwayLine } from "../../lib/runway";

const DAY = 86_400_000;
const now = 1_788_800_000_000;
const cr = (n: number) => `${n} cr`;

/** Runway (brief 2.2): the last seven calendar days' spend, quiet days counting as zero, read as days the balance lasts. */
test("the pace is the last seven days over seven, and the runway is the balance at that pace", () => {
  const byDay = [
    { day: now - 9 * DAY, credits: 500 },  // outside the window
    { day: now - 6 * DAY, credits: 70 },
    { day: now - 3 * DAY, credits: 0 },
    { day: now - 1 * DAY, credits: 140 },
  ];
  const r = runway(600, byDay, now);
  expect(r.spent).toBe(210);
  expect(r.perDay).toBe(30);
  expect(r.days).toBe(20);
  expect(r.known).toBe(true);
  expect(runwayLine(r, cr)).toBe("At 30 cr a day over the last 7 days, about 20 days of runway.");
});

test("it says nothing without a pace, and speaks plainly at the edges", () => {
  expect(runway(600, [], now).known).toBe(false);
  expect(runwayLine(runway(600, [], now), cr)).toBe("");
  expect(runway(null, [{ day: now, credits: 10 }], now).known).toBe(false);
  expect(runwayLine(runway(5, [{ day: now, credits: 70 }], now), cr)).toBe("At 10 cr a day over the last 7 days, the balance does not last the day.");
  expect(runwayLine(runway(100_000, [{ day: now, credits: 7 }], now), cr)).toBe("At 1 cr a day over the last 7 days, more than a year of runway.");
  expect(runwayLine(runway(31, [{ day: now, credits: 210 }], now), cr)).toBe("At 30 cr a day over the last 7 days, about 1 day of runway.");
});
