import { test, expect } from "@playwright/test";
import { parseCharacters } from "../../lib/higgsfield-consumer/characters";

/** FINAL_SPEC §4 › Soul ID: the account's trained characters, bounded and text-only, wherever the reply nests them. */
test("characters are read by soul_id or id, typed and statused only from the known words, and never from junk", () => {
  const reply = { characters: [
    { soul_id: "soul_9f2a", name: "Mira / character study", type: "soul_2", status: "ready", preview_url: "https://cdn.example/mira.jpg" },
    { id: "abc-123", name: "", type: "soul_cinematic", status: "training", preview_url: "http://insecure.example/x.jpg" },
    { soul_id: "bad id with spaces", name: "Nope" },
    { soul_id: "x".repeat(300), name: "Too long" },
    "not a record",
    { soul_id: "soul_odd", name: "Odd", type: "lora", status: "queued" },
  ] };
  expect(parseCharacters(reply)).toEqual([
    { soulId: "soul_9f2a", name: "Mira / character study", type: "soul_2", status: "ready", previewUrl: "https://cdn.example/mira.jpg" },
    { soulId: "abc-123", name: "abc-123", type: "soul_cinematic", status: "training", previewUrl: null },
    { soulId: "soul_odd", name: "Odd", type: null, status: null, previewUrl: null },
  ]);
  expect(parseCharacters({ results: [{ soul_id: "s1", name: "One" }] })).toHaveLength(1);
  expect(parseCharacters([{ soul_id: "s2", name: "Two" }])).toHaveLength(1);
  expect(parseCharacters({ nothing: true })).toEqual([]);
  expect(parseCharacters(null)).toEqual([]);
  expect(parseCharacters({ items: Array.from({ length: 150 }, (_, i) => ({ soul_id: `s${i}`, name: `n${i}` })) })).toHaveLength(100);
});

import { parseCharacterCreate, parsePlan, soulBuildBlock, SOUL_BUILD_STILLS } from "../../lib/higgsfield-consumer/soul-build";

/** Cast › Build identity on the connected account (FINAL_SPEC §3 › Soul ID): the plan gate, the block reasons, the reply parser. */
test("the plan gate reads the account's plan under any of its spellings and calls free-tier names unpaid", () => {
  expect(parsePlan({ current_plan: "Pro" })).toEqual({ plan: "Pro", paid: true });
  expect(parsePlan({ plan: { name: "Creator" } })).toEqual({ plan: "Creator", paid: true });
  expect(parsePlan({ subscription: "Free" })).toEqual({ plan: "Free", paid: false });
  expect(parsePlan({ plan_name: "Trial 7 days" })).toEqual({ plan: "Trial 7 days", paid: false });
  expect(parsePlan({ credits: 100 })).toEqual({ plan: null, paid: null });
  expect(parsePlan("not an object")).toEqual({ plan: null, paid: null });
});

test("Build identity says why it cannot run, in the card's words, and runs when it can", () => {
  const paid = { connected: true, available: true, plan: "Pro", paid: true };
  expect(soulBuildBlock({ name: "Mira", stills: 6, plan: paid, connected: false })).toBe("Connect the account in Workspace › Engines.");
  expect(soulBuildBlock({ name: "  ", stills: 6, plan: paid, connected: true })).toBe("Name the identity.");
  expect(soulBuildBlock({ name: "Mira", stills: 4, plan: paid, connected: true })).toBe(`Pick ${SOUL_BUILD_STILLS.min}–${SOUL_BUILD_STILLS.max} stills of the same person (4 picked).`);
  expect(soulBuildBlock({ name: "Mira", stills: 21, plan: paid, connected: true })).toContain("21 picked");
  expect(soulBuildBlock({ name: "Mira", stills: 6, plan: { ...paid, plan: "Free", paid: false }, connected: true })).toBe("A paid Higgsfield plan is required — the account reads as Free.");
  /* An account that does not report its plan is not blocked here: it decides at training time. */
  expect(soulBuildBlock({ name: "Mira", stills: 6, plan: { connected: true, available: false, plan: null, paid: null }, connected: true })).toBeNull();
  expect(soulBuildBlock({ name: "Mira", stills: 6, plan: paid, connected: true })).toBeNull();
});

test("a create reply is parsed like the list: the new Soul ID and its status, whichever envelope the account uses", () => {
  const mira = { soul_id: "soul_abc", name: "Mira", type: "soul_2", status: "training" };
  expect(parseCharacterCreate(mira)).toMatchObject({ soulId: "soul_abc", name: "Mira", type: "soul_2", status: "training" });
  expect(parseCharacterCreate({ character: mira })).toMatchObject({ soulId: "soul_abc" });
  expect(parseCharacterCreate({ data: { id: "soul_xyz", name: "Ada", type: "soul_cinematic" } })).toMatchObject({ soulId: "soul_xyz", type: "soul_cinematic", status: null });
  expect(parseCharacterCreate({ items: [mira] })).toMatchObject({ soulId: "soul_abc" });
  expect(parseCharacterCreate({ ok: true })).toBeNull();
  expect(parseCharacterCreate(null)).toBeNull();
  /* Ids are bounded and shaped; a free-text id is not one. */
  expect(parseCharacters([{ id: "bad id with spaces", name: "x" }])).toEqual([]);
});
