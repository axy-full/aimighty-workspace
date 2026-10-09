#!/usr/bin/env node
/*
 * Publishes redesign screenshots (tests/helpers/redesignShots.ts) for a PR and prints the Markdown for its body.
 *
 *   node scripts/redesign/publish-shots.mjs --pr 613 --from ../redesign-shots/home [--from ../redesign-shots/make ...]
 *
 * The images go to the `redesign-screenshots` branch (images only, never merged), under pr-<n>/<screen>/, through a
 * worktree at ../shots-branch, so no PNG ever lands in release/1. Each screen gets a table: the build and the
 * prototype URL beside it, at every size captured.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

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
  /* Only the tool's own output: the PNGs and their JSON notes, top level, nothing else from --from. */
  const picked = readdirSync(from, { withFileTypes: true }).filter((e) => e.isFile() && /^\d+x\d+(-(app|proto|beside))?\.(png|json)$/.test(e.name));
  if (!picked.length) throw new Error(`${from} holds no screenshots.`);
  for (const e of picked) copyFileSync(path.join(from, e.name), path.join(dest, e.name));
  const metas = readdirSync(dest).filter((f) => f.endsWith(".json")).sort().reverse();
  lines.push(`#### ${screen}`, "");
  for (const meta of metas) {
    const info = JSON.parse(readFileSync(path.join(dest, meta), "utf8"));
    const tag = meta.replace(/\.json$/, "");
    const raw = (f) => `https://raw.githubusercontent.com/${REPO}/${BRANCH}/pr-${pr}/${encodeURIComponent(screen)}/${f}`;
    lines.push(`**${tag}** · build \`${info.app}\` · prototype \`${info.prototype}\``, "", `| Build | Prototype |`, `|---|---|`, `| ![build ${tag}](${raw(`${tag}-app.png`)}) | ![prototype ${tag}](${raw(`${tag}-proto.png`)}) |`, "");
  }
}
git("add", "--", `pr-${pr}`);
if (git("status", "--porcelain")) {
  git("commit", "-q", "-m", `Screenshots for PR #${pr}`);
  git("push", "-q", "origin", `HEAD:${BRANCH}`);
}
console.log(lines.join("\n"));
