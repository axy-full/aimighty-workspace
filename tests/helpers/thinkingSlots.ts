/**
 * The Thinking slots a unit spec runs with (owner, 23 Oct 2026, option A): three distinct verified Claude ids, picked by catalogue price
 * (tests/helpers/thinking-slots.mjs), set in this process's env when this file is imported. No spec names a slot's model: each reads it
 * here, at run time.
 */
import { test } from "@playwright/test";
import { NO_SLOTS, SLOT_SETTINGS, slotModelEnv, thinkingSlotEnv } from "./thinking-slots.mjs";
import { CLAUDE_MODEL_IDS, VERIFIED_TEXT_MODEL_IDS } from "../../lib/atomikModelPolicy";

type Setting = "high" | "medium" | "low";
const ENV = thinkingSlotEnv() as Record<string, string>;
/* No three in the catalogue: the slots stay unset, and every spec that reads them fails first with the reason (only those specs). */
if (!Object.keys(ENV).length) test.beforeAll(() => { throw new Error(NO_SLOTS); });

/** Each slot's model, as this run sets it. */
export const SLOTS: Readonly<Record<Setting, string>> = Object.freeze(Object.fromEntries(
  (SLOT_SETTINGS as Setting[]).map((setting) => [setting, ENV[slotModelEnv(setting)]]),
) as Record<Setting, string>);
export const HIGH = SLOTS.high, MEDIUM = SLOTS.medium, LOW = SLOTS.low;

/* Ids a spec needs only as "some model of this family", read from the verified catalogue at run time and never written down. */
/** The verified text ids of one family (`anthropic`, `openai`, `spacexai`, `google`). */
export const familyIds = (owner: string): string[] => VERIFIED_TEXT_MODEL_IDS.filter((id) => id.startsWith(`${owner}/`));
/** The verified Claude ids that are no slot's model. */
export const OTHER_CLAUDE: readonly string[] = CLAUDE_MODEL_IDS.filter((id) => !Object.values(SLOTS).includes(id));
export const OPENAI_IDS = familyIds("openai"), GROK_IDS = familyIds("spacexai"), GEMINI_IDS = familyIds("google");

/** Sets the three slot env variables (the default: this process's env). */
export function setThinkingSlots(env: Record<string, string | undefined> = process.env): void {
  for (const [key, value] of Object.entries(ENV)) env[key] = value;
}

/** Runs `fn` with the slot env variables changed (a value of undefined unsets one), and puts them back after. */
export async function withSlotEnv<T>(changes: Record<string, string | undefined>, fn: () => T | Promise<T>): Promise<T> {
  const before = Object.fromEntries(Object.keys(changes).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(changes)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  try { return await fn(); } finally {
    for (const [key, value] of Object.entries(before)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
}

setThinkingSlots();
