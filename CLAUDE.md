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
10. **Provider APIs and loginless MCP only.** Particl uses provider APIs and loginless MCP only — nothing that needs a Higgsfield sign-in (the account's OAuth MCP, its CLI or a website account). Higgsfield work runs on the API key. Owner's decision, 28 September 2026. Since 2 October 2026 the sign-in features are off: nothing new starts on a Higgsfield account, and past results stay in the Library.

# Pricing

Copied verbatim from docs/particl-sow.md, section 7A. Decided for launch. Anything that spends real money stops and asks first (SOW §13.8); a change to what customers see (plans, packs, the rate card) changes this document too.

Pricing policy (multipliers, margins, floor guard, volume phases) is kept privately by the owner; it is not in this repo. What follows is what customers see and what the code must guarantee. Anything that changes what a workspace is charged needs the owner's approval.

### Credits
- **1 credit = US$0.80, fixed**, the public price (US$0.10 until 28 September 2026). A credit's price is `creditUsd()` (`lib/creditTerms.ts`, `DEFAULT_CREDIT_USD`, overridable by `CREDIT_USD`).
- Every job is priced from engine cost through the margin table (`margins()` in `lib/creditTerms.ts`, overridable by the `CREDIT_MARGINS` env var) and rounded up to the next tenth of a credit per job, never less than 0.1 credit. Batches multiply before rounding. The table is keyed by engine, so pricing one engine differently is a config change, not a refactor.
- The ledger stores `engine_cost_usd` and `billed_credits` per job. The rate card is generated from the adapter registry, never hand-edited.
- Customers never receive vendor costs for work on the platform's keys: no engine cost or margin reaches anyone but a platform admin, and a vendor cost is never shown next to our price. A workspace on its own keys sees its own vendors' dollars.
- **Draft/hero split is a product default, not a pricing tier.** Recipes route boards to standard panels (0.1 cr), draft takes to Kling Standard or Wan (0.8–1.2 cr), and hero takes to Seedance or Kling Pro (3.6–5.4 cr). The composer's model row defaults from the shot's stage in the recipe.

Reference rate card at launch, in credits (regenerate from the code before publishing):

**CORRECTED 10 September 2026, from `lib/vendorRates.ts`.** The card below was
written from costs that did not match the code, and it was wrong in both
directions. Published, it would have over-quoted one row twofold and
under-quoted another fourfold. The app has always billed from the real rates;
it was the card that lied. Two rows named engines that do not exist and are
gone.

Every figure is computed, not asserted: per-second engines are
`rate x seconds` (`secondRateOf`), Seedance is token-priced off the billed
frame (`billedFrame` rounds each side up to a multiple of 16, which is why
1080p is metered at 1088), stills come from `imagePricing`, and every "sells
at" goes through `billCredits`.

**REGENERATED 28 September 2026 at US$0.80 a credit, in tenths**, from the
same code: every row rounds up to the next tenth of a credit.

**AMENDED 28 September 2026 — US$0.80 a credit, charged in tenths.** A job is
charged in tenths of a credit, rounded up, never less than 0.1 (US$0.08). Money
code counts whole tenths, and every ledger row records the price of a credit
its figures were recorded at, so a balance is its exact value in today's
credits. Balances held at US$0.10 are restated by value and rounded up to the
next tenth, one recorded entry per workspace (`lib/creditConversion.ts`),
reversible; receipts keep the terms they were admitted at.

| Action | Sells at |
|---|---|
| Standard still (Nano Banana 2, 512) | 0.1 cr |
| Keyframe still (Nano Banana Pro, 1K) | 0.3 cr |
| Kling 3.0 Standard, 5s 1080p | 0.8 cr |
| Kling 3.0 Standard, 5s 1080p, audio | 1.2 cr |
| Kling 3.0 Pro, 5s 1080p, audio | 1.6 cr |
| Seedance 2.0, 5s 1080p | 3.6 cr |
| Seedance 2.5, 5s 720p | 2.2 cr |
| Seedance 2.5, 5s 1080p | 5.4 cr |
| Topaz upscale, 5s 1080p | 2.9 cr |
| Topaz upscale, 5s 4K | 4.7 cr |
| Identity training (1,500 steps) | 6.8 cr |
| Prompt enhancement | 0.1 cr |

Gone from the card, because the engine is not in the product: **Wan 2.6** —
`alibaba/wan-v3.0-video` appears only in the gateway shortlist and gateway
video is explicitly unrunnable — and **Veo 3.1**, which is in neither
`lib/models.ts` nor `lib/vendorRates.ts`. A VO line is priced per character by
ElevenLabs rather than per call, so it has no single figure and is not a card
row; see the audio terms.

Identity training is priced per step (`TRAIN_STEPS`, `TRAIN_USD_PER_STEP` in
`lib/identities.ts`), with a 1,000-step floor.

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

| Tier | Price | Included | Members |
|---|---|---|---|
| **Invite** | $0 | 25 cr once, 1 production | 3 |
| **Studio** | $49/mo | 50 cr, ~~250 standard panels~~, review links, exports, post tools | unlimited |
| **Agency** | $199/mo | 200 cr, ~~1,000 panels~~, priority queue, branded review links, statements | unlimited |
| **Production** | $999/mo | 1,125 cr, ~~3,000 panels~~, admin console, setup hours | unlimited |

- **Included credits expire at cycle end. No rollover.** (Panels struck, 10 September — see the amendment above.)
- **No seat fees on any paid tier.** Differentiate on credits, priority and features, never headcount.
- **Annual: 20% off.** Auto-cancel: if a workspace has generated nothing in the 60 days before renewal, don't renew — let it lapse and say so.
- ~~Panel inclusions are on the standard engine only.~~ Struck 10 September with the panel rows. Pro stills and all video draw credits regardless of plan — which, with panels gone, is simply: everything draws credits.

### Packs
Unit stays $0.80. Discount only through bonus credits, capped at 20%. Purchased credits last 12 months.

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
| Starter | $49.60 | 62 | $0.800 |
| Team | $200 | 250 + 25 | $0.727 |
| Studio | $500 | 625 + 94 | $0.695 |
| Agency | $2,000 | 2,500 + 500 | $0.667 |

**AMENDED 28 September 2026 — the packs at US$0.80 a credit.** Each pack keeps
its dollar price and buys an eighth of the credits; half a credit cannot be
sold, so Starter is 62 credits at $49.60.

### Guardrails in code
1. Free grant is one-time, never recurring. Invite approvals are capped per month by a platform setting (`grant_budget_usd`).
2. Bonus credits never exceed 20% of a pack.
3. Any workspace consuming more than 25% of the platform's monthly engine spend is flagged to the admin console.
4. Any single job estimated above 25 cr (US$20; 200 cr at US$0.10) requires the workspace's cost approval rule to fire, regardless of the workspace's own setting.
5. Included-credit consumption is metered separately from purchased credits, so statements show what was free and what was paid.
6. Workspaces flagged `internal: true` carry a pricing override set by the private policy. The flag is set only from the platform admin console, never from workspace settings, and its spend is excluded from margin reporting.
