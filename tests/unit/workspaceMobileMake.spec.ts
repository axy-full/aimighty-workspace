import { test, expect } from "@playwright/test";
import {
  billedCredits,
  composerEyebrow,
  dayLabel,
  makeCard,
  makeDays,
  makeHeader,
  makeKindOfType,
  makeTotals,
  MAKE_TABS,
  renderPrimaryLabel,
  specChip,
  takeAge,
  unfiledTakes,
  type MakeSource,
} from "../../lib/workspace/make";
import {
  ATOMIK_RULES,
  creditsCard,
  monthKey,
  monthToDate,
  teamRows,
  topupAction,
  workspaceRows,
} from "../../lib/workspace/settings-data";
import { MOBILE_SHEETS, SHEET_PENDING } from "../../components/workspace/mobile/sheets/registry";
import { MOBILE_SHEETS as SHEET_IDS } from "../../lib/workspace/mobile";
import { INITIAL_STATE } from "../../lib/workspace/navigation";

/**
 * Wave M-C's derivations: the Make wall's header and groups, the Settings
 * mapping, and the sheet registry. All three are pure, so the figures the
 * phone shows are tested without a browser — and the one rule these tests
 * exist to protect is that no figure is written down anywhere.
 */

/* ── Fixtures. Tests only; the app reads these shapes from the real routes. ── */

const DAY = 86_400_000;
/* Local time on purpose: the day groups are the viewer's own days. */
const NOW = new Date(2026, 8, 20, 12, 0, 0).getTime();

function gen(over: Partial<MakeSource> & { id: string }): MakeSource {
  return {
    kind: "video",
    shotId: null,
    model: "dreamina-seedance-2-5-260628",
    prompt: "Wide plate, warm daylight",
    title: null,
    params: { ratio: "16:9", duration: 5 },
    durationS: null,
    status: "succeeded",
    authorName: "You",
    createdAt: NOW - 12 * 60_000,
    creditsBilled: 19,
    storedUrl: null,
    ...over,
  };
}

/* ── The Make wall ──────────────────────────────────────────────────────── */

test("the wall shows only unfiled takes of the tab's own kind, newest first", () => {
  const rows = [
    gen({ id: "a", createdAt: NOW - 60_000 }),
    gen({ id: "b", createdAt: NOW - 10 * 60_000 }),
    gen({ id: "filed", shotId: "shot-1" }),
    gen({ id: "still", kind: "image" }),
  ];
  expect(unfiledTakes(rows, "video").map((row) => row.id)).toEqual(["a", "b"]);
  expect(unfiledTakes(rows, "images").map((row) => row.id)).toEqual(["still"]);
  expect(unfiledTakes(rows, "audio")).toEqual([]);
});

test("the header line is derived: UNFILED · N TAKES · X CR", () => {
  const rows = [
    gen({ id: "a", creditsBilled: 19 }),
    gen({ id: "b", creditsBilled: 13 }),
    gen({ id: "c", creditsBilled: 85 }),
  ];
  expect(makeHeader(rows)).toEqual(["UNFILED", "3 TAKES", "117 CR"]);
  expect(makeTotals(rows)).toEqual({ takes: 3, credits: 117 });
  /* One take is singular, and a wall with nothing on it claims no price. */
  expect(makeHeader([gen({ id: "a", creditsBilled: 4 })])).toEqual(["UNFILED", "1 TAKE", "4 CR"]);
  expect(makeHeader([])).toEqual(["UNFILED", "NO TAKES"]);
});

test("the header counts the ledger's figures only: in flight, failed and connected never inflate it", () => {
  const rows = [
    gen({ id: "done", creditsBilled: 19 }),
    /* In flight: nothing has settled, so it carries no figure at all. */
    gen({ id: "running", status: "running", creditsBilled: null }),
    /* A failure is not billed (CLAUDE.md rule 4's promise, and takes.ts's). */
    gen({ id: "failed", status: "failed", creditsBilled: 0 }),
    /* A connected account paid: not this workspace's credits. */
    gen({ id: "connected", providerCreditQuote: { credits: 30 }, creditsBilled: null }),
  ];
  expect(billedCredits(rows[0])).toBe(19);
  expect(billedCredits(rows[1])).toBeNull();
  expect(billedCredits(rows[2])).toBe(0);
  expect(billedCredits(rows[3])).toBeNull();
  expect(makeHeader(rows)).toEqual(["UNFILED", "4 TAKES", "19 CR"]);
});

test("the wall groups by the day each take was made", () => {
  const days = makeDays(
    [
      gen({ id: "today-1", createdAt: NOW - 12 * 60_000 }),
      gen({ id: "today-2", createdAt: NOW - 26 * 60_000 }),
      gen({ id: "yesterday", createdAt: NOW - DAY }),
      gen({ id: "older", createdAt: NOW - 8 * DAY }),
    ],
    NOW,
  );
  expect(days.map((day) => day.day)).toEqual(["TODAY", "YESTERDAY", "SEP 12"]);
  expect(days[0].count).toBe("2 takes");
  expect(days[1].count).toBe("1 take");
  expect(days[0].items.map((item) => item.id)).toEqual(["today-1", "today-2"]);
  expect(dayLabel(NOW, NOW)).toBe("TODAY");
  expect(dayLabel(NOW - DAY, NOW)).toBe("YESTERDAY");
});

test("a card carries the spec chip, the prompt, the author and the settled cost", () => {
  const card = makeCard(gen({ id: "a" }), NOW);
  expect(card.spec).toBe("SEEDANCE 2.5 · 16:9 · 5S");
  expect(card.by).toBe("You · 12 min");
  expect(card.cost).toBe("19 cr");
  expect(card.rendering).toBe(false);
  /* Rendering: no figure, and the ring goes over the well. */
  const live = makeCard(gen({ id: "b", status: "queued", creditsBilled: null }), NOW);
  expect(live.cost).toBeNull();
  expect(live.rendering).toBe(true);
  /* Failed: said, not hidden, and not billed. */
  expect(makeCard(gen({ id: "c", status: "failed", creditsBilled: 0 }), NOW).cost).toBe("not billed");
  /* No recorded author: the age alone rather than an invented name. */
  expect(makeCard(gen({ id: "d", authorName: null }), NOW).by).toBe("12 min");
});

test("the spec chip reads settings off the generation, never a fixture", () => {
  expect(specChip(gen({ id: "a", params: { ratio: "3:2" }, durationS: null }))).toBe("SEEDANCE 2.5 · 3:2");
  expect(specChip(gen({ id: "b", params: { resolution: "1080p" }, durationS: 6 }))).toBe("SEEDANCE 2.5 · 1080P · 6S");
});

test("ages read in minutes, then the clock, then the date", () => {
  expect(takeAge(NOW - 30_000, NOW)).toBe("just now");
  expect(takeAge(NOW - 12 * 60_000, NOW)).toBe("12 min");
  expect(takeAge(NOW - 3 * DAY, NOW)).toMatch(/^Sep \d+$/);
});

test("the wall's tab and the composer's type are one control", () => {
  expect(MAKE_TABS.map((tab) => tab.label)).toEqual(["Video", "Images", "Audio"]);
  expect(makeKindOfType("image")).toBe("images");
  expect(makeKindOfType("video")).toBe("video");
  expect(makeKindOfType("audio")).toBe("audio");
});

test("the docked card says what would be sent, and the primary carries the live price", () => {
  expect(composerEyebrow({ model: "Motion 2.5", ratio: "16:9", duration: 5 })).toBe("COMPOSER · MOTION 2.5 · 16:9 · 5S");
  expect(composerEyebrow({ model: "Image 2", ratio: "3:2", resolution: "1024", duration: null })).toBe("COMPOSER · IMAGE 2 · 3:2 · 1024");
  expect(composerEyebrow({ model: "Sound", audio: true, seconds: 10 })).toBe("COMPOSER · SOUND · 10S");
  expect(renderPrimaryLabel({ credits: 19, seconds: 5 })).toEqual({ label: "Render", cost: "19 cr · 5s" });
  expect(renderPrimaryLabel({ credits: 1240, seconds: null })).toEqual({ label: "Render", cost: "1,240 cr" });
  /* No live quote, no figure: the button never shows a price it does not have. */
  expect(renderPrimaryLabel({ credits: null, seconds: 5 })).toEqual({ label: "Render", cost: "5s" });
  expect(renderPrimaryLabel({ credits: null, seconds: null })).toEqual({ label: "Render", cost: null });
});

/* ── Settings ───────────────────────────────────────────────────────────── */

const me = {
  name: "A Person",
  role: "admin",
  owner: false,
  workspace: { id: "w1", name: "Studio" },
  credits: { creditUsd: 0.1, granted: 2000, used: 760, balance: 1240 },
  models: { video: "dreamina-seedance-2-5-260628", image: "gpt-image-2" },
};

test("the credits card is computed from /api/me and the usage feed", () => {
  const card = creditsCard(me, { byMonth: [{ month: monthKey(NOW), credits: 612 }] }, NOW);
  expect(card).toEqual({ balance: "1,240 CR", usd: "$124.00", month: "612 CR this month" });
});

test("a figure no route supplies is left out, not invented", () => {
  /* No usage row for this month: the month line is absent. */
  expect(creditsCard(me, { byMonth: [{ month: "2026-01", credits: 5 }] }, NOW)?.month).toBeNull();
  expect(monthToDate(null, NOW)).toBeNull();
  /* A workspace billed outside credits has no credits card at all. */
  expect(creditsCard({ ...me, credits: null }, null, NOW)).toBeNull();
  /* No credit unit, no dollar line. */
  expect(creditsCard({ ...me, credits: { ...me.credits, creditUsd: Number.NaN } }, null, NOW)?.usd).toBeNull();
});

test("Top up names a real pack and links to the flow that owns it", () => {
  const packs = [
    { id: "team", label: "Team", credits: 2000, bonus: 200, total: 2200, usd: 200 },
    { id: "starter", label: "Starter", credits: 500, bonus: 0, total: 500, usd: 50 },
  ];
  expect(topupAction({ applies: true, packs })).toEqual({ label: "Top up · 500 CR · $50", href: "/billing#credit-packs" });
  /* Nothing offered, or credits do not apply: no button rather than a made-up price. */
  expect(topupAction({ applies: true, packs: [] })).toBeNull();
  expect(topupAction({ applies: false, packs })).toBeNull();
  expect(topupAction(null)).toBeNull();
});

test("the workspace rows are the ones the routes could answer", () => {
  const rows = workspaceRows({
    me,
    settings: { settings: { approvalRule: "cap", shotCapCredits: "50" }, models: { video: "dreamina-seedance-2-5-260628", image: "gpt-image-2" } },
    limits: { limits: { rendersPerHour: 60, storageBytes: 50 * 1024 ** 3 }, standing: { usedBytes: 2 * 1024 ** 3 } },
    modelName: (id) => id,
  });
  const labels = rows.map((row) => row.label);
  expect(labels).toContain("Workspace");
  expect(labels).toContain("Cost approval");
  expect(labels).toContain("Shot cap");
  expect(labels).toContain("Request ceiling");
  expect(rows.find((row) => row.label === "Storage")?.value).toBe("2 GB of 50 GB");
  expect(rows.find((row) => row.label === "Shot cap")?.value).toBe("50 CR per shot");

  /* With nothing readable, the section is empty rather than full of defaults. */
  expect(workspaceRows({ me: null, settings: null, limits: null, modelName: (id) => id })).toEqual([]);
});

test("team rows show a role only where the route returned one", () => {
  const withRoles = teamRows({
    canSeeRoles: true,
    users: [
      { id: "1", email: "a@b.co", name: "Ada Lovelace", standing: "owner" },
      { id: "2", email: "grace@b.co", name: null, role: "member" },
    ],
  });
  expect(withRoles).toEqual([
    { id: "1", initials: "AL", name: "Ada Lovelace", role: "Owner" },
    { id: "2", initials: "GR", name: "grace@b.co", role: "Member" },
  ]);
  /* The route withholds roles from a member; the phone does not guess them. */
  const hidden = teamRows({ canSeeRoles: false, users: [{ id: "1", email: "a@b.co", name: "Ada Lovelace" }] });
  expect(hidden[0].role).toBeNull();
  expect(teamRows(null)).toEqual([]);
});

test("the three Atomik rules are the three the design names", () => {
  expect(ATOMIK_RULES.map((rule) => rule.label)).toEqual(["EVERY PAID STEP", "PROPOSE ONLY", "NEVER WITHOUT YOU"]);
  for (const rule of ATOMIK_RULES) expect(rule.sub.length).toBeGreaterThan(10);
});

/* ── The sheet registry ─────────────────────────────────────────────────── */

test("all four sheets are registered on the one chrome, and nothing is pending", () => {
  expect(Object.keys(MOBILE_SHEETS).sort()).toEqual([...SHEET_IDS].sort());
  for (const id of SHEET_IDS) {
    const def = MOBILE_SHEETS[id];
    expect(def.title.length).toBeGreaterThan(0);
    expect(def.Body, `${id} has a body`).toBeTruthy();
    /* Nothing says "arrives later" any more. */
    expect(SHEET_PENDING[id]).toBe("");
  }
});

test("each sheet's own line is derived from the state it opens over", () => {
  const state = { ...INITIAL_STATE, page: "rig" as const, selKind: "take" as const };
  expect(MOBILE_SHEETS.inspector.sub?.({ project: null, state })).toBe("Asset");
  expect(MOBILE_SHEETS.atomik.sub?.({ project: null, state })).toBe("Rig");
  expect(MOBILE_SHEETS.library.sub?.({ project: null, state })).toBe("Rig");
  /* Only Atomik carries the ring in its header. */
  expect(MOBILE_SHEETS.atomik.ring).toBe(true);
  expect(MOBILE_SHEETS.inspector.ring).toBeUndefined();
  expect(MOBILE_SHEETS.library.ring).toBeUndefined();
});
