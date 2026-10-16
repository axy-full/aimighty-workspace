# If aimighty-workspace went private: an estimate (16 Oct 2026)

Owner's question, 16 Oct 12:40: estimate only, nothing changed. Written by the lead.

## 1. CI minutes and cost

**Measured, last 30 days (16 Sep to 16 Oct):** 2,323 workflow runs, from the GitHub API run list.

| Workflow and outcome | Runs | Billable minutes per run (sample of 300 runs) | Estimated minutes |
|---|---|---|---|
| Verify, success | 769 | 349 | ~268,000 |
| Verify, failure | 299 | 295 | ~88,000 |
| Verify, cancelled | 1,042 | 141 | ~147,000 |
| Dependabot updates | 26 | 1 to 3 | ~60 |
| Encrypted backups | 184 | 0 (all skipped) | 0 |
| **Total** | | | **~503,000 minutes a month** |

How the minutes are counted: each job's run time is rounded up to whole minutes, as GitHub bills it. One Verify run is about 24 jobs in parallel.

**Runner type:** every job runs on `ubuntu-latest`, the standard 2-core Linux runner. Nothing uses a larger runner, so there is no larger-runner charge.

**Prices, from GitHub's own docs (16 Oct 2026):**
- Public repo: standard runners are free.
- Private repo:
  - included minutes per month: 2,000 on Free, 3,000 on Pro or Team;
  - beyond that, Linux 2-core costs $0.006 a minute;
  - minutes are rounded up per job;
  - the pricing page lists no multipliers, just a price per runner type.

**What it would cost private, at today's usage:** about (503,000 − 3,000) × $0.006 ≈ **$3,000 a month**. On Free (2,000 included) the figure is about the same.

**Cutting CI waste** would roughly halve that, whatever the repo's visibility:
- **Cancelled runs** (lane pushes we cancel, and runs replaced by a newer push) still burn about 147,000 minutes, because they are cancelled mid-run.
- **Fix 1:** run the 24-job suite only when a PR is marked ready, or only from the lead's readiness runs. Lane pushes would get a 3-job quick check (tsc, lint, unit).
- **Fix 2:** skip browser shards when no UI file changed.
- With both, a likely figure is 150,000 to 250,000 minutes, about **$900 to $1,500 a month** if private.

## 2. What breaks if it goes private

1. **Production deploys (Coolify), likely.**
   - If Coolify clones the repo anonymously over HTTPS (a public repo needs no credentials), deploys fail until Coolify has a GitHub App or a deploy key for it.
   - The lead can't read Coolify settings, so the owner should check this first.
2. **Screenshots in PRs.**
   - `scripts/redesign/publish-shots.mjs` puts images on the `redesign-screenshots` branch and links them as `raw.githubusercontent.com` URLs. 35 PR bodies use these.
   - In a private repo those images don't render, even for signed-in people.
   - Fix: switch the script to `github.com/<repo>/blob/<branch>/<path>?raw=true` links, which render for people with access, and re-publish the old ones if needed.
3. **Branch protection and required checks.**
   - GitHub's plan table limits branch rules on Free to public repositories.
   - On a personal Free account, a private repo loses protected branches and required status checks, including the gitleaks check being added.
   - It needs GitHub Pro (personal) or Team (organisation).
4. **Not affected:**
   - **The app's own files (`public/`, MCP download links):** the app serves these itself. A search found no app code that reads from GitHub.
   - **Dependabot:** still free.
   - **CodeQL:** not used.
   - **The backup workflow:** all its runs are skipped.
   - **Reviewers and lanes on the droplet:** they use an authenticated `gh`.
5. **Docs links:** `github.com/.../blob/...` links in docs keep working for anyone with access.

## 3. A cheaper option: self-hosted runners

**GitHub's docs today say self-hosted runners are free**, on public and private repos.
- **Unconfirmed, to check before deciding:** the lead recalls a GitHub announcement of a small per-minute platform fee for self-hosted runners on private repos in 2026. The docs read on 16 Oct do not show one.
- At $0.002 a minute it would be about $1,000 a month at today's usage, and much less after the waste cuts.

**Sizing:**
- A Verify run is about 350 runner-minutes. At about 70 runs a day, that is about 24,000 runner-minutes a day, or about 17 runners busy around the clock.
- A single small droplet can't absorb that. An 8 vCPU / 16 GB droplet runs about 4 jobs at once, so one Verify run would take about 90 minutes instead of about 25.
- A realistic self-hosted setup costs about $100 to $400 a month on DigitalOcean:
  - CI cut to 150,000 to 250,000 minutes first;
  - then 2 to 4 droplets of 8 vCPU / 16 GB, or one 32 vCPU box;
  - check current DigitalOcean prices.
  - It is slower per run than GitHub's 24-way fan-out.

**Security trade-off:**
- A runner executes every PR's code. On a private repo, only collaborators can open PRs, which makes this acceptable.
- On a public repo it is not acceptable (a fork PR could run code on the box).
- The runner must be a separate machine, never the production droplet. Use ephemeral runners (one job per fresh VM or container), give it no production network access, and give it no secrets beyond what the job needs.
- It also adds upkeep: OS updates, Playwright browsers, disk.

## 4. Recommendation
- **Stay public until after 31 Oct.**
- **Cut CI waste now.** It is worth about half the minutes either way.
- **If you then go private,** in this order:
  1. Pro or Team for branch protection.
  2. A Coolify GitHub App or deploy key.
  3. The screenshot-link fix.
  4. Pay for hosted minutes (about $900 to $1,500 a month after the cuts).
  5. Self-hosted only if the bill matters more than speed.
