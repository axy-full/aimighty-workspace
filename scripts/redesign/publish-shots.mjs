#!/usr/bin/env node
/*
 * Publishes redesign screenshots (tests/helpers/redesignShots.ts) for a PR and prints the Markdown for its body.
 *
 *   node scripts/redesign/publish-shots.mjs --pr 613 --from ../redesign-shots/home [--from ../redesign-shots/make ...]
 *
 * The images go to the `redesign-screenshots` branch (images only, never merged), under pr-<n>/<screen>/, through a
 * worktree at ../shots-branch, so no PNG ever lands in release/1. Each screen gets a table: the build and the
 * prototype URL beside it, at every size captured. A size at a pixel ratio of 2 is tagged `2560x1440@2x`; the table shows the
 * downscaled WebPs and links each to its full-size PNG.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { SHOT_FILE, tableFor, tagsOf } from "./shot-files.mjs";

const args = process.argv.slice(2);
const pr = args[args.indexOf("--pr") + 1];
const froms = args.flatMap((a, i) => (a === "--from" ? [args[i + 1]] : []));
if (!/^\d+$/.test(pr ?? "") || !froms.length) {
  console.error("usage: publish-shots.mjs --pr <number> --from <shots dir> [--from <dir> ...]");
  process.exit(2);
}
const BRANCH = "redesign-screenshots";
const REPO = "axy-full/aimighty-workspace";
const tree = path.resolve("../shots-branch");
const git = (...a) => execFileSync("git", a, { cwd: tree, stdio: ["ignore", "pipe", "inherit"] }).toString().trim();

if (!existsSync(tree)) {
  execFileSync("git", ["fetch", "-q", "origin"], { stdio: "inherit" });
  const remote = execFileSync("git", ["ls-remote", "--heads", "origin", BRANCH]).toString().trim();
  if (remote) execFileSync("git", ["worktree", "add", "-q", tree, `origin/${BRANCH}`], { stdio: "inherit" });
  else execFileSync("git", ["worktree", "add", "-q", "--orphan", "-b", BRANCH, tree], { stdio: "inherit" });
  if (remote) git("switch", "-q", "-C", BRANCH, `origin/${BRANCH}`);
}
/* Never act on any other checkout: the folder must be its own worktree root, on the screenshots branch, with
   nothing uncommitted, before anything is fetched, rebased, added or pushed. */
if (realpathSync(git("rev-parse", "--show-toplevel")) !== realpathSync(tree)) throw new Error(`${tree} is not a worktree root.`);
if (git("branch", "--show-current") !== BRANCH) throw new Error(`${tree} is not on ${BRANCH}.`);
if (git("status", "--porcelain")) throw new Error(`${tree} has uncommitted changes; publish nothing.`);
git("fetch", "-q", "origin");
if (git("ls-remote", "--heads", "origin", BRANCH)) git("rebase", "-q", `origin/${BRANCH}`);

const lines = [];
for (const from of froms) {
  const screen = path.basename(path.resolve(from));
  const dest = path.join(tree, `pr-${pr}`, screen);
  mkdirSync(dest, { recursive: true });
  /* Only the tool's own output: the PNGs, WebPs and their JSON notes, top level, nothing else from --from. */
  const picked = readdirSync(from, { withFileTypes: true }).filter((e) => e.isFile() && SHOT_FILE.test(e.name));
  if (!picked.length) throw new Error(`${from} holds no screenshots.`);
  for (const e of picked) copyFileSync(path.join(from, e.name), path.join(dest, e.name));
  const files = readdirSync(dest);
  lines.push(`#### ${screen}`, "");
  for (const tag of tagsOf(files).reverse()) {
    const info = JSON.parse(readFileSync(path.join(dest, `${tag}.json`), "utf8"));
    const raw = (f) => `https://raw.githubusercontent.com/${REPO}/${BRANCH}/pr-${pr}/${encodeURIComponent(screen)}/${encodeURIComponent(f)}`;
    lines.push(...tableFor({ tag, info, files, raw }));
  }
}
git("add", "--", `pr-${pr}`);
if (git("status", "--porcelain")) {
  git("commit", "-q", "-m", `Screenshots for PR #${pr}`);
  git("push", "-q", "origin", `HEAD:${BRANCH}`);
}
console.log(lines.join("\n"));
