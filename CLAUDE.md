@AGENTS.md

# Ground rules

Copied verbatim from docs/particl-sow-v1.md, section 3. The scope of work is the source of truth; read it in full before touching code, and update it when a change makes it wrong (SOW §13.4).

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
11. **Every feature is agentic.** A feature ships as a tool in the registry (A1) before it gets a button. The button, Make, a board card, Atomik, a saved skill and an outside agent over MCP all call the same tool, at the same price, through the same approval gate. Each tool has a mocked test proving the agent can run it. Every screen that offers a feature also lets the person ask Atomik to do it; when Atomik fills a form, the fields visibly fill before anything is pressed. A few actions belong to people alone: approving spend, setting spend limits and the budget ceiling, topping up, approving a post, and recording consent for a real person's face or voice. Atomik and outside agents can prepare and explain these, never take them (rule 14). *(Amended 21 October 2026, the owner:)* The same tool costs the same through every path. The agent factor is not a path price; it is a mode price, keyed on who chose the engine: a job Atomik routed (engine chosen by Atomik, the how hidden) carries `AGENT_PRICE_FACTOR` whatever path started it — button, Make, board, skill or MCP; a job whose caller chose the engine never does.
12. **One board.** Productions, ad campaigns and social projects live on one board engine: the Rig's team canvas, extended in S1. New project work is a card kind, a group or a skill on that board, never a new page.
13. **Easy by default.**
    - Auto is the default for agent, model, engine and settings, shown as one line with a Change link (in Director, for example "Seedance 2.5 · 1080p · 5 s · 43 cr · Change"; in Agent mode the line shows the what and the price, for example "Final · 5 s · 51 cr · Change", label amended 21 October 2026). Advanced settings live folded in the Inspector.
    - What the brief sets (aspect, frame rate, look, cast) carries into every shot and is not asked again.
    - One primary button per screen, and it is the next step.
    - Everything saves itself. No "save first" errors; today's live in `components/workbench/AtomikRunDialog.tsx`, `SoulIdentityPanel.tsx` and `Studio.tsx`.
    - Undo instead of confirmation dialogs (nothing is ever erased already).
    - Plain words in the UI (names in the 4 October 2026 amendment, §3). Cut any sentence the screen could show instead (rule 9).
14. **Money without anxiety.**
    - Prices read `N cr`, `up to N cr` (a live estimate) or `free`. Never the bare word "quoted". Hovering a price shows its dollar value at the public price of a credit. Prices come only from the rate card (CLAUDE.md § Pricing, through the server's price path); every price in a design is a sample.
    - **Amended 21 October 2026, a fourth form for bands only (the owner):** "the cost range can be given, but not the absolute cost." An Atomik band (Reading, Research, Analysis, Writing) may read `N–M cr`: reserved at M, settled at what was used. Engine steps stay exact; every other price keeps the three forms above.
    - Only a person approves spending. Atomik and outside agents can prepare, price and explain an approval, never grant one; an approval written by `agent:*` or an MCP caller is refused. When a person tells Atomik in words to approve ("approve everything under 10 cr"), Atomik lists exactly what that covers and its total, and the person confirms with one tap.
    - **Amended 21 October 2026, a token with a ceiling.** The owner, verbatim (20 October 2026): "An admin sets a ceiling per token in credits per month; every paid request from a token or an MCP client carries its approved quote; a token with no ceiling can only prepare and price." And: "a token with a ceiling spends inside it whatever the workspace's Ask setting — the ceiling is the standing approval. lip_sync follows the same rule once Auto goes, so the two tools behave alike." The admin who sets the ceiling is the person approving; a token's request inside it carries its quote and grants nothing beyond it. An approval written by `agent:*` or an MCP caller is still refused, ceiling or not: the ceiling is the only approval a token carries.
    - A plan is approved once: one tap approves its listed steps at their listed prices, up to its total, including a stated fix allowance (at most two fixes per shot). Anything outside it (a new shot, a fix past the allowance, another engine) asks again. ~~A plan's approval follows the workspace's rule in `lib/approvalRule.ts`: a step over the rule's cap needs an admin, and the plan card says which steps need whom.~~ (Retired 21 October 2026; see "Admin approval rule retired" under Owner decisions.)
    - Outside a plan, every paid step asks, unless the workspace allows spending without asking. Today's Ask and Auto modes (`lib/workbench/rig-agent-limits.ts`) become that setting: Ask is the default; in Auto, a draft priced at or under the per-job line runs without a tap. A job above guardrail 4 (`JOB_APPROVAL_LINE_USD`, US$20: 200 cr at $0.10) never runs without a tap. Only an admin changes the setting or the budget ceiling.
    - Atomik's own thinking (questions, the plan, review notes) is billed as the planning turn is today in `lib/workbench/rig-agent.ts`: reserved against a limit the person approves when asking, settled at what it used, and not billed when nothing came back. Decision 7 in the 4 October 2026 amendment's §10 may change this.
    - The balance is checked against a plan's total before it starts, with Top up offered then, never halfway through.
    - A failed step that cost nothing says "Nothing billed" and offers Retry, which re-runs it under the same approval; a failed step that was charged says what it cost.
15. **Readable dark.** Text people read is at least 12 px and at least 55% white on black (about 6:1; WCAG AA asks 4.5:1). Fainter text is for disabled things only. Focus rings are always visible. Touch targets are at least 44 px on phones. Separate areas with space and hairlines, not grey boxes.
16. **No Higgsfield sign-in.** Restates rule 10 for all new work: every replacement in the 4 October 2026 amendment's §5.3 runs on a provider API key, and anything on Higgsfield runs on its API key (`api.higgsfield.ai`, with `HF_API_KEY_ID` and `HF_API_KEY_SECRET` or `HF_CREDENTIALS`). A PR that adds or keeps a Higgsfield tool names its endpoint. A tool that would need a Higgsfield account is not built.
17. **Measure ease.** The five-minute rule (rule 6) becomes a Playwright test, landed as U1's first PR and run on every UI PR after it: a new person with an invite reaches an approved first render. The product records time to first render, approvals per session and where people stop, as ids and timings only, never prompt text.

# Owner decisions since 10 Oct 2026

These amend the ground rules above and the scope they were copied from (the full list is in docs/redesign-plan.md, "Owner decisions", on the redesign branches).

- **"Rig" is a UI word again.** Prototype 12 names a board view "Rig" and the owner kept the name. The old ban (4 Oct scope, "No UI text says … Rig …") is lifted for it; the other retired words stay banned (`tests/helpers/uiStrings.ts`).
- **"quoted"** is shown where an action has no live quote path, which overrides rule 14's "never the bare word quoted" for the prototype-12 build. Each such action is listed in docs/redesign-progress.md.
- **The new-interface switch** (`lib/newInterface.ts`) stays until launch: off for every customer workspace, on for the house workspace.
- **Remotion (owner, 13 Oct 2026).** Remotion: Free License, confirmed by Remotion 13 Oct 2026; no licence key, nothing sent to Remotion; pinned to 4.x. SensAI is 3 people in total. Rendering is self-hosted on our own server only (no Remotion Lambda, no AWS), on a sealed worker with no internet, and only our own templates are rendered; users never upload Remotion projects. **When SensAI's headcount reaches 4, the Remotion Company License must be bought before the next release.** Any upgrade to Remotion 5.x is flagged to the owner first (5.0 may require a key): NEEDS AKSHAY. Remotion exports are free to customers (0 cr, "Free") for as long as Remotion charges us nothing; paid engine steps inside an export are priced as usual; only the owner sets a price for exports. The plan is docs/plans/remotion.md on the redesign branches.
- **Design (18 Oct).** The 31 Oct demo runs on the live v25 screens. v30 is superseded: the interface after the demo is built from the approved v31.2 design (Claude Design). No interface work starts until that zip is in the repo as THE design. *(22 Oct: that zip is v31.16, `docs/design/v31.16/`; see "The design lock" below.)*
- **Money behaviour (decided 18 Oct; supersedes the 16–17 Oct wording and amends rule 14).** These are the rules the product is built to. Until sign-off, today's billing code stays as it is, including: the 200 cr line, 480p drafts first, the house cap, the billing of failed and cancelled jobs, and the billing of Atomik's planning turn (17 Oct: "leave today's billing on until … signs off — a charge going away is still a money change"). (20 Oct: the 200 cr line is retired; see "Guardrail 4 retired" below.)
  - A Preflight card comes before every quote. The Preflight card and the quote are free (18 Oct).
  - Everything Atomik makes is charged and quoted first. That includes plans, research, analysis and text revisions, priced as Reading · Research · Analysis · Writing bands. Atomik's own check of its work is free and is never a line (18 Oct). This replaces rule 14's planning-turn sentence once built and signed off.
  - "Each Agent quote is ONE all-in credit price, shown before approval and charged exactly, with no breakdown" (16 Oct). This replaces rule 14's "its listed steps at their listed prices" for Agent mode. "Charged exactly" is not needed for the demo; it ships after 31 Oct with Stripe (16 Oct).
  - Enhance has no Undo (18 Oct) and is free if it fails (16 Oct). It is priced "as it costs, shown before pressing. 1 cr for an ordinary prompt; a long prompt in a heavier script quotes 2 cr. No byte cap on the prompt, no lower reasoning allowance" (19 Oct). The final figure comes after sign-off; build the quote path, not the number (19 Oct). "Options" is a priced chip (18 Oct).
  - Agent History is one line per command, and no engine name appears in Agent mode anywhere, History included (18 Oct). Agent jobs never expose an engine in the API, receipts, exports or error messages; Director jobs expose what they chose (17 Oct).
  - The monthly spend limit: only the workspace owner may raise it, and removing it counts as raising it (17 Oct). For this limit, that replaces rule 14's "an admin". It runs on the UTC calendar month; reaching it finishes the running job and starts nothing new; the pause lifts when the new month starts (17 Oct).
- **Keep and Sent (19 Oct; extends rule 4 with Keep, and renames its "approved" to Sent).** "Keep is a separate mark (kept_at, kept_by), not today's approved. Today's approved is a commit; the commit is Sent. Every reader of 'approved' (export, review links, shot locks) follows Sent on output steps and Kept on Look and Elements. Name each reader in its PR." Send does not need Keep, and a card shows both (Q13).
- **Guardrail 4 retired (19–20 Oct; amends rule 14).** This retires rule 14's sentence "A job above guardrail 4 (`JOB_APPROVAL_LINE_USD`, US$20: 200 cr at $0.10) never runs without a tap." The owner: "the 200 cr per-job line (guardrail 4) is retired. Every job is approved on its quote before it runs; the only automatic stop is the workspace's monthly spend limit with its Paused state. #815 keeps "a multi-shot press is one job, one approval for the total" and drops the guardrail-4 check; a press whose total would pass the workspace cap is refused at the quote. Update CLAUDE.md's pricing section and the rulebook in the docs PR; a money review on the #815 change. Nothing else in the money behaviour changes." On 20 October 2026 the owner widened it, verbatim: "Guardrail 4 is retired everywhere, single jobs included: no per-job line in the product. Every job is approved on its quote before it runs; the only automatic stop is the workspace's monthly spend limit with Paused. Strike it in CLAUDE.md and the scope with a dated note in the owner's words, and in the code with its own money review; keep the workspace cap and the house cap exactly as they are." What replaces it is under § Pricing › Guardrails in code (AMENDED 19 and 20 October 2026). The per-job line is removed from the code by its own code PR, under its own money review. The workspace cap (its monthly spend limit) and the house cap stay exactly as they are. ~~The workspace's own approval rule (a step over the workspace's own rule cap needs an admin; `lib/approvalRule.ts`) is not guardrail 4 and stays.~~ Retired 21 October 2026: see "Admin approval rule retired" below.
- **Auto goes (20 Oct; amends rule 14).** This retires rule 14's sentences on Ask and Auto ("in Auto, a draft priced at or under the per-job line runs without a tap"). The owner, verbatim: "Q2 Auto goes: every job is approved on its quote; "Ask before every take" off means one approval per step. ~~Q3 a big Atomik step still goes to an admin, keyed to the workspace cap, never to a fixed figure.~~ Q4 the per-render ask over 200 cr goes. Q5 the balance check, token ceilings, run limits, project caps ~~and the per-shot rule~~ stay." The same code PR removes Auto and its no-tap ceiling, and a plan's per-render ask over 200 cr: every render runs on its own tap or a plan's one approval, at its quote. ~~"The workspace cap" in Q3 is the per-shot rule cap in `lib/approvalRule.ts`.~~ (Q3, and the per-shot rule in Q5, struck 21 October 2026: see "Admin approval rule retired" below.) A token with a monthly ceiling an admin set spends inside it; the owner, verbatim: "C. Yes: a token with a ceiling spends inside it whatever the workspace's Ask setting — the ceiling is the standing approval. lip_sync follows the same rule once Auto goes, so the two tools behave alike." See § Pricing › Guardrails in code (AMENDED 20 October 2026 — Auto goes).
- **Admin approval rule retired (21 Oct; amends rule 14, and the 20 Oct Q3 above).** The owner, verbatim: "the admin approval rule is retired; every member approves their own spend with their own tap on the quote; Atomik, tokens and MCP callers still never approve. This overturns my 20 Oct Q3 ('a big Atomik step still goes to an admin') and rule 14's sentence 'a step over the rule's cap needs an admin' — strike both with this dated note." And: "The monthly limit stays as a mechanism, off by default, owner-only, no Paused card." And: "Auto: retired. Every job is approved on its quote by the person pressing; the 'Ask before every take' setting goes." Asked whether work already waiting for an admin goes back to its own person at a fresh quote and starts only on their tap, with a claim already rendering left to finish, and whether a production at its cap still waits for an admin's Unlock, he answered "yes" to each. This strikes rule 14's sentence "A plan's approval follows the workspace's rule in `lib/approvalRule.ts`: a step over the rule's cap needs an admin, and the plan card says which steps need whom." and Q3 above, and it strikes "the only automatic stop is the workspace's monthly spend limit with its Paused state" as a rule: the monthly limit stays as a mechanism, off by default, owner-only, with no Paused card, and the house cap and the platform allowance stay exactly as they are. Every member approves their own spend with their own tap on the quote; no step, take or plan waits for an admin. Work that waited for one goes back to its own person at a fresh quote and starts only on their tap; a claim already rendering finishes. A production at its cap still waits for an admin's Unlock. The balance check, token ceilings and run limits stay. See § Pricing › Guardrails in code (AMENDED 21 October 2026 — the admin approval rule is retired).
- **Library origin (18 Oct).** A trained likeness is "uploaded": it is of a real person and carries the consent tick. Anything made from it is "generated".
- **The design lock (22 Oct, 23:53; Amendment, 22 October 2026 (iii), F).** The owner: "lets put this into lead." Prototype v31.16 is THE design: `docs/design/v31.16/`. Its README.txt is the screen map: every `?view=…&step=…&mode=…` state is a screen the product must have. CHANGES.txt is the change record, and the prompts v31.7–v31.16 are in `docs/design/prompts/`. The p311-*.js files are a throwaway rendering, never a source: build from the README, the prompts and the screens, with the components the repo already has.
  - Locked: the step order; the pill · rail · canvas · bar · panel structure; Keep and Sent; the money surfaces (quote, Preflight, receipt, Top up); the Atomik tab (questions in the panel, never on the bar); the record.
  - Adjustable in flight: words, the How page, pill sizes, which quick starts show.
  - All copy lives in one strings table (never inline in components). Copy changes are data PRs, guarded by the forbidden-words test.
  - Not reproduced (Claude Design fixes them): a new node landing over another card; the console's `{{ p.d }}` path warning; the Thinking row below the fold on the Brief at 1440.
- **How Atomik asks (22 Oct; Amendment (iii) A; amends SOW S1, S2, C2 and rule 13).**
  - The owner: "The agent will think and ask each question separately. Not present 3 questions at once to the user. That way I want the agent to ask as many questions as it wants for its clarity. And the atomik bar will spin when the agent is thinking." The three-question caps are struck (R2, S1, C2), and the count is Atomik's.
  - "Dont show too many options in agentic mode": at most four answer pills, plus a field. Nothing is asked twice, and nothing the brief, the Look, the Elements or the Director's own work already answers is asked.
  - "I dont wanna see random questions. Take your time to study the output once created and then suggest questions basis what you see." Before a thing is made, Atomik asks what it needs. After, it studies the result and suggests from what it sees. **[money] NEEDS AKSHAY:** whether the 21 Oct B4 bound (one judge call per take, absorbed) widens to every asset kind and to suggestions.
  - A job shows Thinking · Making · Reviewing at one quote. Questions, suggestions and selection never sit on the one-line bar; they go in the Atomik tab.
  - Agent mode carries the Look and Elements into every frame and shot (rule 13 now names them).
- **The floor (22 Oct; Amendment (iii) H; amends R2 and D1).** "The checklist is the floor, not the ceiling." The floor rows are fixed, deterministic and tested: never asked when something answers them, always asked when nothing does. Above the floor, Atomik asks whatever the film makes genuinely open, one at a time, from no list. "Decide for me" is the default and the one multi-word button; "Just make it" is retired (R3).
- **Director mode (22 Oct; Amendment (iii) B and J; amends R8, R10 and rule 13).**
  - Settings are remembered per node and per step, with one Generate · N cr; a settings change alone never runs anything.
  - Clicking a take shows its Take tab first. A change makes a new take beside it, never over it.
  - On Elements a new node asks its kind first (Cast · Prop · Environment · Vehicle · Wardrobe · Product · Words · World).
  - Sound's inspector shows sound only.
  - "The Director never starts from a blank prompt": every Director node is born filled from the record. The Prompt row ("Prompt · as it will be sent") is assembled with no model running, so it is free. ✦ Enhance · N cr and Compose · up to N cr are priced live **[money]**.
  - The bar is for the change. Again with… duplicates a take. Wires are drawn, never required.
  - No agent factor on a Director job; Compose's own price is the only Atomik charge.
- **Surfaces and copy (22 Oct; Amendment (iii) C).** The owner: "Copy like 'Just make it. The same quote. No questions' is amateur copy. Revise the copy across the platform and make it more polished, technical, single worded (wherever possible) and crisp."
  - Buttons are one word and labels are nouns. No line over eight words survives unrewritten.
  - Retired: "Just make it", "No questions", "the editor is the director's", "Storyboard · N kept from Look".
  - "How Particl works" is a static page built last, from the real screens. Home has one bar and no Settings tile. Make's wall is headed "Library". World is a first-class Elements kind.
- **Engines and vendors (22 Oct; Amendment (iii) D).** Each adapter lands as a registry tool first (rule 11).
  - Ideogram 4.5 for words that read and precise edits (`IDEOGRAM_API_KEY`, `IDEOGRAM_ENABLED`) **[money]**.
  - World Labs Marble as the World kind (`WORLDLABS_API_KEY`, `WORLDLABS_ENABLED`) **[money] [schema]**.
  - Docling replaces LibreOffice + Tesseract for reading documents; Polotno stays under the Treatment.
  - SAM on fal for selections and masks. Still- and clip-edit engines are chosen by bake-off, under $20 each, on the owner's yes, in the house workspace.
  - The Remotion Editor Starter is bought only after Edit's transitions are checked against it.
  - Gemini stays on AI Studio.
  - Keys go into the self-host configuration by the owner; the `_ENABLED` switches stay off until the mocked tests pass.
- **Atomik's thinking, three settings (22 Oct, evening; Amendment (iii) E) [money].** The owner, verbatim: "lets have 3 settings. High (Fable 5.1/55 high when it launches) Medium (Opus 5.5 high) Low (Sonnet 5.5 high) (never disclose to the user the models and effort settings".
  - The person sees only High · Medium · Low under "Thinking". The model and its effort are never shown: not in the UI, History, receipts, exports, the API, errors or "How Particl works".
  - The mapping lives in `lib/atomikModelPolicy.ts` only (`ATOMIK_THINKING`), env-overridable, with a test that no model id or effort string reaches a rendered string or an API response.
  - It is set per production at the Brief, default Medium; a workspace admin sets the workspace default. The judge, digests and routine turns run at Low unless the setting is High.
  - The Treatment deck's prose is written by the OpenAI writer (`TREATMENT_WRITER`, model id and effort from env); Claude, at the production's setting, does everything else. The xAI family leaves the Atomik allowlist (**NEEDS AKSHAY:** confirm).
  - Each setting has its own band rates in the private policy; nothing is charged for the setting itself.

# Pricing

Copied verbatim from docs/particl-sow-v1.md, section 7A. Decided for launch. Anything that spends real money stops and asks first (SOW §13.8); a change to what customers see (plans, packs, the rate card) changes this document too.

Pricing policy (multipliers, margins, floor guard, volume phases) is kept privately by the owner; it is not in this repo. What follows is what customers see and what the code must guarantee. Anything that changes what a workspace is charged needs the owner's approval.

### Credits
- **1 credit = US$0.10, fixed**, the public price. A credit's price is `creditUsd()` (`lib/creditTerms.ts`, overridable by `CREDIT_USD`).
- Every job is priced from engine cost through the margin table (`margins()` in `lib/creditTerms.ts`, overridable by the `CREDIT_MARGINS` env var) and rounded up to the next whole credit per job. Batches multiply before rounding. The table is keyed by engine, so pricing one engine differently is a config change, not a refactor.
- **The agent factor (amended 21 October 2026, the owner).** A job Atomik routed (engine chosen by Atomik, the how hidden) carries `AGENT_PRICE_FACTOR` (env-set, default 1.0, the number is the owner's) whatever path started it — button, Make, board, skill or MCP; a job whose caller chose the engine never does. It is a mode price, not a path price (rule 11). The public rate card stays the Director rate card; Agent prices are the all-in quote. Platform-admin margin reporting includes the factor; nothing customer-facing shows it.
- The ledger stores `engine_cost_usd` and `billed_credits` per job. The rate card is generated from the adapter registry, never hand-edited.
- Customers never receive vendor costs for work on the platform's keys: no engine cost or margin reaches anyone but a platform admin, and a vendor cost is never shown next to our price. A workspace on its own keys sees its own vendors' dollars.
- **Draft/hero split is a product default, not a pricing tier.** Recipes route boards to standard panels (1 cr), draft takes to Kling Standard or Wan (4–8 cr), and hero takes to Seedance or Kling Pro (25–45 cr). The composer's model row defaults from the shot's stage in the recipe.

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

| Action | Sells at |
|---|---|
| Standard still (Nano Banana 2, 512) | 1 cr |
| Keyframe still (Nano Banana Pro, 1K) | 3 cr |
| Kling 3.0 Standard, 5s 1080p | 7 cr |
| Kling 3.0 Standard, 5s 1080p, audio | 10 cr |
| Kling 3.0 Pro, 5s 1080p, audio | 13 cr |
| Seedance 2.0, 5s 1080p | 29 cr |
| Seedance 2.5, 5s 720p | 18 cr |
| Seedance 2.5, 5s 1080p | 43 cr |
| Topaz upscale, 5s 1080p | 23 cr |
| Topaz upscale, 5s 4K | 38 cr |
| Identity training (1,500 steps) | 54 cr |
| Prompt enhancement | 1 cr |

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

**AMENDED 11 October 2026 — the owner's final plans, and the reversal of "no seat fees".** Display
configuration only: checkout is later, and no credit math, margin or `CREDIT_USD` changes. The plans (`lib/plans.ts`) are:

| Plan | Price | Included credits |
|---|---|---|
| **Explore** (one person) | $50/mo | 500 cr |
| **Create** (one person) | $100/mo | 1,000 cr |
| **Master** (one person) | $250/mo | 2,500 cr |
| **Business 100** (a team) | $100 per seat per month | 1,000 cr per seat |
| **Business 250** (a team) | $250 per seat per month | 2,500 cr per seat |
| **Business 500** (a team) | $500 per seat per month | 5,000 cr per seat |
| **Enterprise** | Get in touch | no price, no plan id |

- **Business is one shared workspace, priced per seat per month, with credits pooled across the seats** (a workspace's cycle
  credits are its seats times the level's credits). **One level per workspace: no mixing.** The plan card reads "from $100 per seat".
  **This reverses the earlier rule "No seat fees on any paid tier. Differentiate on credits, priority and features, never
  headcount."** (owner, 11 October 2026). Business seats are display only until checkout counts them: no paid or Business plan caps members in code; Invite keeps its 3 (`lib/planLimits.ts`). `applyPaidSubscriptionPeriod` (`lib/billingLedger.ts`) accepts only the old plan ids (studio, agency, production) until checkout extends it.
- Every figure is $0.10 a credit. Monthly only: the yearly period is hidden (its config, `ANNUAL_DISCOUNT_PERCENT`, is kept).
- **Invite** ($0, 250 cr once, 1 production, 3 members) stays as the hidden default for a new workspace, and **Studio ($49, 400 cr),
  Agency ($199, 1,600 cr) and Production ($999, 9,000 cr)** stay as hidden legacy plans: a workspace on one still resolves it, and none
  is offered. The public site names the team plans "Business" too (owner, 12 October 2026: the 7 Oct ban on the word is lifted; it still may not print "workspace").
- **Low-credit warning:** at 20% of the cycle's credits (the pooled total for Business), from the ledger's funded cycle
  (`billing_cycles.credits`), else the welcome grant, else no warning. A plan an admin only labels grants nothing and warns nothing.

The earlier rows (kept for the record; offered no longer except as the hidden legacy plans above):

| Earlier plan | Price | Included | Members |
|---|---|---|---|
| **Invite** | $0 | 250 cr once, 1 production | 3 |
| **Studio** | $49/mo | 400 cr, ~~250 standard panels~~, review links, exports, post tools | unlimited |
| **Agency** | $199/mo | 1,600 cr, ~~1,000 panels~~, priority queue, branded review links, statements | unlimited |
| **Production** | $999/mo | 9,000 cr, ~~3,000 panels~~, admin console, setup hours | unlimited |

- **Included credits expire at cycle end. No rollover.** (Panels struck, 10 September — see the amendment above.)
- ~~**No seat fees on any paid tier.** Differentiate on credits, priority and features, never headcount.~~ Reversed 11 October 2026 for Business plans (above); the individual plans have one person.
- ~~**Annual: 20% off.**~~ Not offered for now: the owner's plans are monthly (11 October 2026); the rule stands if yearly returns.
- **Auto-cancel:** if a workspace has generated nothing in the 60 days before renewal, don't renew — let it lapse and say so.
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
1. Free grant is one-time, never recurring. Invite approvals are capped per month by a platform setting (`grant_budget_usd`).
2. Bonus credits never exceed 20% of a pack.
3. Any workspace consuming more than 25% of the platform's monthly engine spend is flagged to the admin console.
4. ~~Any single job estimated above 200 cr requires the workspace's cost approval rule to fire, regardless of the workspace's own setting.~~ Retired 19–20 October 2026; see the amendments below.
5. Included-credit consumption is metered separately from purchased credits, so statements show what was free and what was paid.
6. Workspaces flagged `internal: true` carry a pricing override set by the private policy. The flag is set only from the platform admin console, never from workspace settings, and its spend is excluded from margin reporting.

**AMENDED 19 October 2026 — guardrail 4 is retired.** The owner, verbatim: "the 200 cr per-job line (guardrail 4) is retired. Every job is approved on its quote before it runs; the only automatic stop is the workspace's monthly spend limit with its Paused state. #815 keeps "a multi-shot press is one job, one approval for the total" and drops the guardrail-4 check; a press whose total would pass the workspace cap is refused at the quote. Update CLAUDE.md's pricing section and the rulebook in the docs PR; a money review on the #815 change. Nothing else in the money behaviour changes."

What replaces it:
- Every job is approved on its quote before it runs.
- ~~The only automatic stop is the workspace's monthly spend limit, with its Paused state.~~ Struck 21 October 2026: the monthly limit stays as a mechanism, off by default, owner-only, with no Paused card; the house cap and the platform allowance stay exactly as they are (see the amendment of 21 October 2026 below).
- A multi-shot press is one job, with one approval for its total. A press whose total would pass the workspace cap is refused at the quote.

**AMENDED 20 October 2026 — every job, single jobs included.** The owner, verbatim: "Guardrail 4 is retired everywhere, single jobs included: no per-job line in the product. Every job is approved on its quote before it runs; the only automatic stop is the workspace's monthly spend limit with Paused. Strike it in CLAUDE.md and the scope with a dated note in the owner's words, and in the code with its own money review; keep the workspace cap and the house cap exactly as they are."

The per-job line (`JOB_APPROVAL_LINE_USD` in `lib/approvalRule.ts`, judged by `jobLineVerdict` from `lib/generationRequests.ts`, `lib/shotCap.ts` and `lib/quote.ts`) is removed from the code by its own code PR, under its own money review. The workspace cap (its monthly spend limit) and the house cap stay exactly as they are. ~~The workspace's own approval rule (a step over the workspace's own rule cap needs an admin; `lib/approvalRule.ts`) is not guardrail 4 and stays.~~ Retired 21 October 2026: see the amendment of that day below.

**AMENDED 20 October 2026 — Auto goes.** The owner, verbatim: "Q2 Auto goes: every job is approved on its quote; "Ask before every take" off means one approval per step. ~~Q3 a big Atomik step still goes to an admin, keyed to the workspace cap, never to a fixed figure.~~ Q4 the per-render ask over 200 cr goes. Q5 the balance check, token ceilings, run limits, project caps ~~and the per-shot rule~~ stay." The same code PR removes Auto and its no-tap ceiling, and a plan's per-render ask over 200 cr: every render runs on its own tap or a plan's one approval, at its quote. ~~"The workspace cap" in Q3 is the per-shot rule cap in `lib/approvalRule.ts` (owner, 20 October 2026).~~ (Q3, and the per-shot rule in Q5, struck 21 October 2026: the admin approval rule is retired; see below.) An API token or an MCP client spends only inside a monthly ceiling an admin set, carrying its approved quote; the owner, verbatim: "C. Yes: a token with a ceiling spends inside it whatever the workspace's Ask setting — the ceiling is the standing approval. lip_sync follows the same rule once Auto goes, so the two tools behave alike."

**AMENDED 21 October 2026 — a press asked again.** The owner, verbatim: "fix the #815 press route (a repeated press near the cap shows the running press) as its own money PR"; "Retry's price is only the shots left: what failed unbilled re-runs under the same approval; what was charged stays charged"; "held approvals expire as plans do (7 days); an expired one asks again at the current price." With his #811 answer, the approval binds the total: per-shot shifts at or under it run, a higher total asks again.

- Asked again under its key, a press is read before it is priced: shots that started are shown as they stand, at the hold they started at, and are not judged against the cap a second time. Only the shots still to start (never started, or failed at no charge) are priced, capped and checked against the balance (`lib/batchPress.ts`).
- Retry costs only the shots left, under the approval the press holds, while the press's total stays at or under it; a higher total asks again with the new total.
- A press's approval is drawn on for 7 days from when it first started something (the plan approval's `PLAN_APPROVAL_MS`). After that, a press that would start anything asks again at today's price.

**AMENDED 21 October 2026 — the admin approval rule is retired.** The owner, verbatim: "the admin approval rule is retired; every member approves their own spend with their own tap on the quote; Atomik, tokens and MCP callers still never approve. This overturns my 20 Oct Q3 ('a big Atomik step still goes to an admin') and rule 14's sentence 'a step over the rule's cap needs an admin' — strike both with this dated note." And: "The monthly limit stays as a mechanism, off by default, owner-only, no Paused card." And: "Auto: retired. Every job is approved on its quote by the person pressing; the 'Ask before every take' setting goes." Asked whether work already waiting for an admin goes back to its own person at a fresh quote and starts only on their tap, with a claim already rendering left to finish, and whether a production at its cap still waits for an admin's Unlock, he answered "yes" to each.

- No step, take or plan waits for an admin. The workspace's cost approval rule and its per-shot cap (the `approvalRule` and `shotCapCredits` settings, read by `lib/approvalRule.ts` and `lib/shotCap.ts`) are removed from the code by their own code PR, under its own money review. A workspace's stored values stay as they are (nothing is erased); nothing reads them, and the settings route refuses them.
- Work that waited for an admin goes back to its own person at a fresh quote and starts only on their tap; a claim already rendering finishes.
- A production at its cap still waits for an admin's Unlock.
- The house cap and the platform allowance stay exactly as they are; so do the balance check, token ceilings and run limits.
- The monthly spend limit is its own later change: a mechanism, off by default, set by the owner only, with no Paused card.
