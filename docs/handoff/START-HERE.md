# Start here — opening prompt for a new Claude Code session

Paste everything in the fenced block below as your first message in the new account. It points the session at
the right files, gives it the owner's working preferences (which a fresh account has no memory of), and tells it
what to do first.

```text
You are taking over Particl, a live AI film-production and marketing app. Repo: axy-full/aimighty-workspace
(GitHub). Production: https://www.particl.app (Vercel project "particlstudio"). Next.js 16, React 19,
TypeScript, Tailwind v4, Node 24.

READ FIRST, IN ORDER, BEFORE CHANGING ANYTHING:
1. docs/handoff/HANDOFF.md — state, binding rules, what is proven vs assumed, the queue, the traps.
2. docs/handoff/status.md — the running record; keep it true as you work.
3. CLAUDE.md — the repo's ground rules (pricing, tenant isolation, phones first class, small PRs).
4. docs/handoff/connected-capability-audit-2026-09-19.md — the connected-account capability map.
Then run `curl -s https://www.particl.app/api/health` and `git log --oneline -15 origin/main` so you know
the live state before you trust any of the documents.

HOW THE OWNER WORKS (you have no memory of this yet — save it to your own memory):
- They want things done, not explained. When the request is clear, act; do not ask permission for reversible
  work. They have said plainly that they do not want "silly excuses" for why something can't be built.
- But real money and real publishing need their explicit word each time: every paid provider test needs a
  stated spending ceiling, and a previous approval is not a budget. Anything that posts publicly or deploys
  a site needs an explicit confirmation on top of the price approval.
- Never use serif fonts in any design for them. Default to bold sans / grotesk / mono.
- Extend the existing /api routes and lib; never rebuild them ("I will not rebuild the APIs again").
- Atomik (the agent suite) is to have full parity with the connected provider's agent product — every
  feature, power and resource — without ever naming the provider in the UI.
- Model names: real names for models we call directly (Seedance 2.5, Kling 3.0, Nano Banana 2, Eleven v3,
  GPT-6 Astra, Claude Fable 5.1, Gemini…). Neutral names only for models served through the connected
  account. Never print Higgsfield, Supercomputer, Genjutsu or Soul ID.
- One credit is US$0.10 (creditUsd() in lib/creditTerms.ts). Connected-account credits are the provider's
  currency and are never converted at that rate.

WORKING RULES:
- One concern per PR, from its own git worktree off origin/main. Full CI (.github/workflows/verify.yml) must
  be green before merging. Never merge red, never use --admin.
- Every change ships with Playwright at 360x640, 390x844, 844x390, 1440x900 and 1920x1080.
- Commit messages end with a blank line then:
    Co-Authored-By: <your model name> <noreply@anthropic.com>
  PR descriptions end with:
    🤖 Generated with [Claude Code](https://claude.com/claude-code)
- Never hard-code /private/tmp paths in a spec; use info.outputPath(...).
- Before calling a CI failure a flake, check main is green on the same spec and rebase on origin/main.
- Verify on the live site after a merge, not just in CI. The owner signs in on the built-in browser pane;
  workbench fetches need the header X-Workbench-Scope: particl-active-<workspaceId>-<userId> from /api/me.
- Never rotate KEYRING_SECRET. Never create a Vercel project, GitHub org or Inngest org.

MACHINE NOTES (only if you are on the owner's Mac):
- Git's global author must stay the GitHub noreply address 275056119+axy-full@users.noreply.github.com.
  Vercel silently blocks deployments whose commit author isn't associated with the account — no error, the
  deploy just never goes live.
- If `npm install` fails with EACCES on ~/.npm, set NPM_CONFIG_CACHE to a writable directory in the same
  command; the real fix needs the owner's password.
- Worktrees symlink node_modules from the main checkout; Turbopack rejects that, so run dev servers with
  `npx next dev --webpack -p <port>`. CI uses Turbopack from cold — reproduce CI by cloning node_modules
  with `cp -Rc` and running `npm run dev`.

WHAT TO DO FIRST:
1. Confirm the handoff matches reality (main head, open PRs, /api/health). Report any drift.
2. The one decision waiting on the owner is in HANDOFF.md §9, item 1: whether to flip phones from the old
   routes onto the new phone build. Ask them that, briefly, and do not flip until they answer.
3. Meanwhile pick up the queue from HANDOFF.md §9 in order, one PR per item, and keep docs/handoff/status.md
   current as you go. Record what you proved, with the command and the counts, and what you only assumed.
```

## Why this exists

Most of the expensive defects in this codebase were assumptions that read like facts: fixture shapes invented
rather than recorded, a timing race that only showed on a cold server, a stale merge base mistaken for a flaky
test. The handoff documents what was proven and how. Keep it that way for whoever comes after you.
