import { test, expect } from "@playwright/test";
import { spawnSync } from "node:child_process";

/**
 * One design: design/particl-graphite/ is the only design and app/graphite.css
 * the only token set, so no tracked file names an older design, its handoff,
 * spec or style sheet. Git history keeps them. The design folder may name what
 * it replaced, and two documents are history: docs/handoff-diff.md and
 * docs/handover-2026-10-05.md.
 *
 * The names are spelled in pieces so this file does not match its own search.
 */
const NAMES = [
  ["particl", "v2"], ["particl", "suites"], ["particl", "site"],
  ["legacy", "graphite"], ["mobile", "handoff"], ["four-suites-v2", "plan"],
].map((parts) => parts.join("-"));
const PATHS = ["docs/hand" + "off/", "docs/phase" + "-0"];
const WORDS = ["fl" + "air", "GLASS" + "_SPEC", "design_hand" + "off_"];
const EXEMPT = ["design/particl-graphite/", "docs/handoff-diff.md", "docs/handover-2026-10-05.md"];

test("no file outside the design names an older design, handoff or style sheet", () => {
  const pattern = [...NAMES, ...PATHS, ...WORDS].join("|");
  const run = spawnSync("git", ["grep", "-n", "-i", "-I", "-E", pattern, "--", ".", ...EXEMPT.map((path) => `:!${path}`)], { encoding: "utf8" });
  test.skip((run.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT", "git is not installed");
  /* git grep exits 1 when nothing matches. */
  expect([0, 1], run.stderr).toContain(run.status);
  expect(run.stdout.split("\n").filter(Boolean)).toEqual([]);
});
