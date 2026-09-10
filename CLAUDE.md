@AGENTS.md

# Ground rules

Copied verbatim from docs/particl-sow.md, section 3. The scope of work is the source of truth; read it in full before touching code, and update it when a change makes it wrong (SOW §13.4).

1. **Other people's money.** Every render bills a customer workspace in credits they paid for. Never trigger a generation, training run or upscale against a customer workspace. Development uses mocked engine responses; if a test needs a real call it runs in a dedicated internal workspace, and you state the cost and wait for a yes.
2. **Tenant isolation is the floor.** Every table carries `workspace_id`; every query filters on it; every Blob path is prefixed by it; every signed URL is scoped to it. Identities, cast, masters, prompts, costs and rules never cross a boundary. If you can't point at where a query is scoped, it's a bug.
3. **Nothing tied to one studio in the code.** Rules, defaults and the camera bank become the **platform layer** — inherited by every workspace, overridable by each. No workspace, client or person names in source, seed data or copy.
4. **Don't redesign what works.** Shot/take, draft → picked → approved, cost-on-the-button, Setup carried into every shot, `@cast`, file naming, caps. Extend; don't replace.
5. **One vocabulary.** Enforced in code, decided once. Current state on particl.app is close: Takes / Productions / Generate. Remaining drift: the dock says `GENERATE` while the segmented control says Video / Images / Audio.
6. **Five minutes.** A stranger with an invite gets from email to first render in five minutes without reading a paragraph. Every screen is judged against that person.
7. **Two first-class surfaces, different jobs.** Desktop is where work is made: composing, wiring Rig, reviewing at speed, bulk actions, admin. Mobile is where work is judged: watch a run, compare, approve, unlock a cap. Neither is a shrunken version of the other. Every change ships with Playwright checks at 360×640, 390×844, 844×390, 1440×900 and 1920×1080. No horizontal overflow at any width; primary actions reachable without panning; dock and sheets clear of the home indicator; no fixed-width layout stranding whitespace above 1600px.
8. **Small PRs**, one concern each, in phase order.
9. **Prose in the product is a cost.** The copy voice is good; there's too much of it. Where a paragraph explains what the UI should make obvious, fix the UI and cut the paragraph.

# Pricing

Copied verbatim from docs/particl-sow.md, section 7A. Decided for launch. Anything that spends real money stops and asks first (SOW §13.8); anything that changes what a workspace is charged changes this document too.

The governing rule: **every tier is profitable even if the customer uses everything included.** Cost every inclusion at full use, at engine cost plus 3% payment fees. Typical usage (40–60% of inclusions) is where the margin lives; worst case is the floor.

### Credits
- **1 credit = US$0.10, fixed.** Sell price = engine cost × 1.5, rounded up to the next whole credit per job. Batches multiply before rounding.
- The ledger stores `engine_cost_usd`, `billed_credits` and `margin_pct` per job. The rate card is generated from the adapter registry, never hand-edited.
- **Floor guard:** if any engine's rolling 7-day margin drops under 10%, its sell multiplier auto-raises to restore 1.5× and the platform admin is alerted. This runs in the metering layer, not in a spreadsheet.
- **The aimighty workspace is billed at cost.** For now, the aimighty workspace (and any other workspace flagged `internal: true` in the admin console) has its sell multiplier set to 1.0 — credits are charged at exact engine cost plus payment fees, with no platform margin, and no platform fee. It sits on the same ledger, the same metering, the same statements as every other workspace; the only difference is the multiplier. This is a per-workspace override on the same field that Phase B tunes per engine, so it costs nothing to build and nothing to remove. The admin console shows internal workspaces separately in spend and margin reporting so they never distort the platform's numbers.
- **Draft/hero split is a product default, not a pricing tier.** Recipes route boards to standard panels (1 cr), draft takes to Kling Standard or Wan (4–8 cr), and hero takes to Seedance or Kling Pro (25–45 cr). The composer's model row defaults from the shot's stage in the recipe. This is how a production stays competitive while per-clip prices sit above aggregators with volume rates.

Reference rate card at launch (regenerate from live engine costs before publishing):

| Action | Engine cost | Sells at |
|---|---|---|
| Standard panel (Nano Banana fast) | ~$0.04 | 1 cr |
| Keyframe still (Nano Banana Pro) | ~$0.15 | 3 cr |
| Wan 2.6 draft, 5s | ~$0.25 | 4 cr |
| Kling 3.0 Standard, 5s | ~$0.50 | 8 cr |
| Kling 3.0 Pro, 5s, audio | ~$1.68 | 26 cr |
| Seedance 2.5, 5s, 720p | ~$1.60 | 24 cr |
| Seedance 2.5, 5s, 1080p | ~$2.86 | 43 cr |
| Veo 3.1, 5s, audio | ~$2.00 | 30 cr |
| Topaz upscale, 5s | ~$0.40 | 6 cr |
| VO line (ElevenLabs) | ~$0.03 | 1 cr |
| Identity training | ~$2.00 | 30 cr |
| Prompt enhancement | ~$0.01 | 1 cr |

### Tiers

**AMENDED 10 September 2026 — panels are out of the tier rows, and expiry is
on.** Two decisions taken after mapping §7A against the code:

1. **The panel inclusions are cut. Tiers differentiate on credits alone for
   launch.** "250 / 1,000 / 3,000 standard panels" is an allowance on a unit
   that does not exist: there is no panel object, table, column, route, count
   or cap anywhere in the code, nothing marks an engine "standard", and the
   board pipeline those panels would come out of (§2.8, stages 1–5) is
   entirely unbuilt. A standard board panel bills at exactly 1 credit, so the
   value of each row is re-expressible in credits with nothing lost. **Panel
   allowances wait for §2.8.** The original rows are kept below, struck
   through, so the intent is not lost.
2. **Credit expiry is no longer deferred; it comes first.** See §14.

Three words in §7A also collide with words the code already uses, and the
code's meanings are older. `tier` is a RESOLUTION BAND in the vendor rate
table (`RateTier`, `TableTier`). `allowance` is a monthly DOLLAR CEILING on
engine spend — a stop, not a grant, the opposite kind of object. `panel` is a
region of UI (`--color-panel`). Rule 5 says one vocabulary, decided once, so
the tier work uses **plan** for the subscription and keeps `tier` meaning what
it already means.

| Tier | Price | Included | Members | Worst-case cost | Worst-case gross |
|---|---|---|---|---|---|
| **Invite** | $0 | 50 cr once, 1 production, boards at 1 cr | 3 | $3.50 | marketing cost |
| **Studio** | $49/mo | 400 cr, ~~250 standard panels~~, review links, exports, post tools | unlimited | $38 | $11 · 22% |
| **Agency** | $199/mo | 1,600 cr, ~~1,000 panels~~, priority queue, branded review links, statements | unlimited | $153 | $46 · 23% |
| **Production** | $999/mo | 9,000 cr, ~~3,000 panels~~, admin console, setup hours | unlimited | $750 | $249 · 25% |

- **Included credits expire at cycle end. No rollover.** Breakage is real margin. (Panels struck, 10 September — see the amendment above.)
- **No seat fees on any paid tier.** Differentiate on credits, priority and features, never headcount.
- **Annual: 20% off.** Auto-cancel: if a workspace has generated nothing in the 60 days before renewal, don't renew — let it lapse and say so.
- ~~Panel inclusions are on the standard engine only.~~ Struck 10 September with the panel rows. Pro stills and all video draw credits regardless of plan — which, with panels gone, is simply: everything draws credits.

### Packs
Unit stays $0.10. Discount only through bonus credits, capped at 20%. Purchased credits last 12 months.

**AMENDED 10 September 2026 — a pack does not expire while the workspace is
on a plan.** The 12 months is time spent OFF a plan; a subscriber's purchased
credits sit still.

Why: with a plan's included credits spent first (which is what makes them
included), a subscriber who stays inside their monthly allowance never touches
their packs. A uniform 12-month lifetime would then expire credits the
customer paid cash for and was structurally prevented from spending. That is
not breakage, it is a charge for nothing. Breakage is meant to fall on a
balance somebody walked away from, and a subscriber has not walked away —
they are paying every month.

**This is a sequencing constraint, not just a rule.** The exemption is part of
the rule, and it cannot be honoured before plans exist to be exempt from. So
purchase expiry does not ship first: either it ships WITH plans, or after
them. Shipping the 12 months on its own would expire the credits of the exact
customers this amendment protects, with nothing in the code able to tell that
they should have been protected.

Still open, and only reachable once plans exist: whether leaving a plan
RESUMES the remaining months or restarts them. It has no answer today because
nothing can leave a plan, and the two differ only for someone who has.

| Pack | Price | Credits | Effective |
|---|---|---|---|
| Starter | $50 | 500 | $0.100 |
| Team | $200 | 2,000 + 200 | $0.091 |
| Studio | $500 | 5,000 + 750 | $0.087 |
| Agency | $2,000 | 20,000 + 4,000 | $0.083 |

### Guardrails in code
1. Free grant is one-time, never recurring. Invite approvals are capped per month by a platform setting (`grant_budget_usd`); each approval costs ~$3.50.
2. Bonus credits never exceed 20% of a pack.
3. Any workspace consuming more than 25% of the platform's monthly engine spend is flagged to the admin console.
4. Any single job estimated above 200 cr requires the workspace's cost approval rule to fire, regardless of the workspace's own setting.
5. Included-credit consumption is metered separately from purchased credits, so statements show what was free and what was paid.
6. Workspaces flagged `internal: true` bill at multiplier 1.0 and pay no platform fee. The flag is set only from the platform admin console, never from workspace settings, and its spend is excluded from margin reporting.

### What changes at volume (do not build now — flags only)
- **Phase B (~$20–50k/mo engine spend):** volume rates from ModelArk, Kling and fal at committed spend, target 20–30% off. **Hold sell prices flat**; margin rises to ~50%. Move standard panels to GPU-hour open weights (panel cost under 1¢). Per-engine multipliers tuned from the ledger: premium 1.7×, commodity 1.4×.
- **Phase C (300+ workspaces):** own GPU pool for open-weight draft video, enterprise contracts, BYOK for large studios on a higher platform fee, recipe marketplace with revenue share.

Build the adapter so the multiplier is per engine from day one, even though it launches at a flat 1.5×. That's a config change later, not a refactor.

### Milestones
Hard fixed costs ≈ $300/mo. Typical contribution: Studio ~$32, Agency ~$110, Production ~$550.
- Break-even on hard costs: ~10 Studio or 3 Agency.
- One salary (~$4k/mo): ~15 Agency + 30 Studio, or 4 Production + 10 Agency.
- ~$25k/mo contribution: ~40 Agency + 100 Studio + 8 Production — roughly where Phase B rates lift every number by ~15 points.
