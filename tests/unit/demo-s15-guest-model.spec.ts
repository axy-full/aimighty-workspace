import { test, expect } from "@playwright/test";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { DEFAULT_SITE, INVITE_ONLY, cleanSite, sitePatch } from "../../lib/site/settings";
import { decodeGuestBrief, firstBoard, GUEST_BRIEF_KEY } from "../../lib/guest/brief";
import { SAMPLE_TITLE, cleanSampleTitle } from "../../lib/guest/sample";

test("site settings: off by default; only exact booleans and well-formed ids survive", () => {
  expect(DEFAULT_SITE).toEqual({ openSignup: false, guestHome: false, guestWorkspace: null });
  expect(cleanSite(null)).toEqual(DEFAULT_SITE);
  expect(cleanSite([true])).toEqual(DEFAULT_SITE);
  expect(cleanSite({ openSignup: "true", guestHome: 1, guestWorkspace: "ws a; drop" })).toEqual(DEFAULT_SITE);
  expect(cleanSite({ openSignup: true, guestHome: true, guestWorkspace: "ws_123", extra: 1 })).toEqual({ openSignup: true, guestHome: true, guestWorkspace: "ws_123" });
  expect(INVITE_ONLY).toBe("Sign-up needs an invitation link.");
});

test("site patch: the three fields only, each checked", () => {
  expect(sitePatch({ openSignup: true })).toEqual({ patch: { openSignup: true } });
  expect(sitePatch({ guestWorkspace: null, guestHome: false })).toEqual({ patch: { guestWorkspace: null, guestHome: false } });
  expect("error" in sitePatch({ openSignup: "yes" })).toBe(true);
  expect("error" in sitePatch({ guestWorkspace: 42 })).toBe(true);
  expect("error" in sitePatch({ welcomeCredits: 9000 })).toBe(true);
  expect("error" in sitePatch({})).toBe(true);
  expect("error" in sitePatch(null)).toBe(true);
});

test("the kept brief: seven days, text and chips only, empty is nothing", () => {
  const now = Date.UTC(2026, 9, 5);
  const enc = (v: unknown, at = now) => JSON.stringify({ v, at });
  expect(GUEST_BRIEF_KEY).toBe("particl:guest-brief");
  expect(decodeGuestBrief(enc({ text: "A film about rain.", aspect: "9:16", length: "30 s", files: ["x"] }), now)).toEqual({ text: "A film about rain.", aspect: "9:16", length: "30 s" });
  expect(decodeGuestBrief(enc({ text: "Old." }, now - 8 * 86_400_000), now)).toBeNull();
  expect(decodeGuestBrief(enc({ text: "  " }), now)).toBeNull();
  expect(decodeGuestBrief("{broken", now)).toBeNull();
  expect(decodeGuestBrief(null, now)).toBeNull();
});

test("the first board is Home's Film template made from the brief", () => {
  const { name, seed } = firstBoard({ text: "A 15-second film about quiet confidence. More words.", aspect: "9:16", length: null });
  expect(name).toBe("A 15-second film about quiet confidence");
  expect(seed).toEqual({ brief: "A 15-second film about quiet confidence. More words.", aspect: "9:16", deliverables: "15 s", boardKind: "studio" });
});

test("the sample's title: the real name when there is one, else the design's", () => {
  expect(SAMPLE_TITLE).toBe("A 15-second film");
  expect(cleanSampleTitle("  A   real   name ")).toBe("A real name");
  expect(cleanSampleTitle("")).toBeNull();
  expect(cleanSampleTitle(7)).toBeNull();
});

/* ── The boundary: a guest's code reaches nothing that thinks, spends or writes ───────────────────────────────── */
const ROOT = path.resolve(__dirname, "../..");
const files = (dir: string) => readdirSync(path.join(ROOT, dir)).filter((f) => /\.(ts|tsx)$/.test(f)).map((f) => path.join(dir, f));
const importsOf = (file: string) => [...readFileSync(path.join(ROOT, file), "utf8").matchAll(/^\s*import\s[^;]*?from\s+"([^"]+)"|^\s*import\s+"([^"]+)"|import\(\s*"([^"]+)"\s*\)/gm)].map((m) => m[1] ?? m[2] ?? m[3]);

test("guest components and the guest reader import only what they are allowed", () => {
  const allowed = new Set([
    "react", "next/link",
    "@/components/ui/Mark", "../icons",
    "../home/BriefBox", "../home/brief-file", "../home/home-model", "../home/TemplateRow", "../home/home.css", "./guest.css",
    "./GuestBox", "./GuestHeader", "./GuestSample", "./SignupSheet", "./RequestAccess",
    "@/lib/guest/brief", "@/components/graphite/home/home-model", "./brief", "./sample",
    "@/lib/platform", "@/lib/site/settings.server",
    /* The guest reader: one workspace's sample, read through stream 12's reader (lib/demo), nothing written. */
    "@/lib/tenant", "@/lib/workbench/records", "@/lib/demo/board.server", "@/lib/demo/mark.server", "./board", "../demo/board", "../demo/content", "@/lib/guest/board",
    "@/lib/shell/create-project", "@/lib/workbench/request-scope",
  ]);
  for (const file of [...files("components/graphite/guest"), ...files("lib/guest")]) {
    for (const spec of importsOf(file)) expect(allowed.has(spec), `${file} imports ${spec}`).toBe(true);
  }
});

test("guest screens call no route but the invitation check and Request access", () => {
  for (const file of files("components/graphite/guest")) {
    const src = readFileSync(path.join(ROOT, file), "utf8");
    const calls = [...src.matchAll(/fetch\(\s*([^\s,]+)/g)].map((m) => m[1]);
    for (const first of calls) expect(['"/api/auth/signup?code="', '"/api/access-request"'], `${file}: fetch(${first}`).toContain(first);
    expect(src, file).not.toMatch(/\bmethod:\s*"(PUT|PATCH|DELETE)"/);
  }
  /* The guest reader opens one workspace, read-only: SELECTs only. */
  const reader = readFileSync(path.join(ROOT, "lib/guest/sample.server.ts"), "utf8");
  expect(reader).not.toMatch(/\b(INSERT|UPDATE|DELETE|REPLACE)\b/);
  expect(reader).not.toMatch(/searchParams|headers\(|cookies\(/);
  expect(reader).not.toMatch(/saveDraft|writeSite|markSampleProduction|hideSampleMark|openSampleDraft/);
});

test("no invented names or shot ids in anything a guest sees", () => {
  const banned = /Dune Studies|Northline|Mira\b|Mara\b|Sethi|Iver|Maison|Night market|\bSH0\d/;
  for (const file of [...files("components/graphite/guest"), ...files("lib/guest"), "components/graphite/guest/guest.css"]) {
    expect(readFileSync(path.join(ROOT, file), "utf8"), file).not.toMatch(banned);
  }
});
