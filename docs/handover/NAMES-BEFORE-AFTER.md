# Names: Soul and Higgsfield out of everything users read (Release 1)

Branch `fix/r1-ui-sweep` (worktree `W/r1-ui-sweep`), base `origin/release/1` 9d67e09b. Private notes; not for the repo.

## What the audit found first

release/1 was already mostly clean. A read of every string a person can read in `app/`, `components/` and `lib/` (JSX text, string and template literals, attributes, page titles, ⌘K data, the manifest, `mcp/`, `public/`) found **no "Soul" and no "Higgsfield" in any label, tooltip, title, toast, phone screen, ⌘K row, Settings row or Usage line**. What the owner saw ("Soul Character", "Soul identity training", "Soul renders") are the engine's old names, already renamed in code: Identity render, Identity training, Identity still · Standard / 2 / Cinema, "Build identity · N cr" (README 3.x frame h). Two leaks were left:

1. **A provider's own message** is kept and shown on a failed take (`lib/providerOutcome.ts` `providerText`). It passed the engine's wording through, so "Your Higgsfield credits…" or "Soul ID training failed…" could reach a person. Fixed (commit af689c73): Soul ID / Soul Character / Soul become "Identity"; "your Higgsfield API" becomes "your engine"; any other Higgsfield becomes "the engine". Links are replaced first, so a host name is not half rewritten.
2. **"Marketing image" / "Marketing Studio Image"**: the product still engine's name, printed in the ledger, the Board's engine column, the Ads card, Atomik's plan step and one accessible name.

## The changes (file:line on the branch, before → after)

### Commit af689c73 (safe, can be pushed now)

| Where | Before | After |
|---|---|---|
| lib/providerOutcome.ts:104-108 `providerText` (every failure message a person reads) | provider text verbatim: "Soul ID …", "Higgsfield …" | "Identity …", "the engine …" |
| tests/unit/ui-names-guard.spec.ts (new tests) | n/a | sample strings that must fail for Soul and Higgsfield (button, tooltip, toast, ⌘K row, template error, capitals, possessive); Topaz Astra 2 still allowed; and a zero-tolerance scan: neither name readable in any UI string, exceptions only lib/vendorNames.ts (the ban list) and lib/workbench/development-plan.ts (a prompt to the planning model) |
| tests/unit/providerNamesScrub.spec.ts (new) | n/a | proves the scrub |

The banned-names check already listed both words (tests/helpers/uiStrings.ts `OLD_WORDS`); it was dated per file. The new zero-tolerance test has no date and no ratchet.

### Commit 1dfccd24 (HOLD: do not push until the owner confirms the two picks)

Both names live in one file, `lib/uiNames.ts`: `IDENTITY_RENDER_NAME` and `PRODUCT_IMAGE_NAME`. Change the value, and every row below follows (tests read the constants too).

| File:line | Before | After (default = my proposal) |
|---|---|---|
| lib/models.ts:520 (model label, the ledger, Usage, statements, Library) | Marketing Studio Image | Product image |
| lib/models.ts:639 (a past job from the earlier account) | Marketing image (earlier account) | Product image (earlier account) |
| lib/workspace/engines.ts:39 (Board engine column, long name) | Marketing image | Product image |
| lib/shell/business.ts:28, :160 (Ads engine picker, catalogue fallback) | Marketing Studio Image | Product image |
| lib/atomikKeySteps.ts:46 (Atomik plan step label) | Marketing Studio Image | Product image |
| components/graphite/board/ads/cards/AdCards.tsx:26 (Ads card engine line) | Marketing Studio Image · 2.0 Alpha · 1:1 · 2K | Product image · 2.0 Alpha · 1:1 · 2K |
| components/workbench/GenerationDialog.tsx:491 (old Gen dialog, accessible name) | Marketing image quality | Product image quality |
| lib/higgsfieldMarketing.ts:420 (error text) | Marketing image references require configured private media storage. | Product image references require configured private media storage. |
| lib/models.ts:528 (model label) | Identity render (literal) | Identity render (same words, now from the constant) |
| lib/workspace/engines.ts:41 (engine long name) | Identity render (literal) | Identity render (from the constant) |
| lib/vendorNames.ts:103 (connected-catalogue rename "Soul Character") | Identity render (literal) | Identity render (from the constant) |
| tests (8 files) | the old strings | the new strings |

Left alone on purpose, for the lead to ask the owner:
- "Marketing Studio" (the product line's name, not on the banned list) still reads in the old Moleculr page, the old Gen dialog ("Marketing Studio build"), error text in `lib/generationAdmission.ts` and `lib/higgsfieldMarketing.ts`, and the marketing site's "one marketing studio". The old pages go with Part 2; the errors I did not touch because they are not the name the owner gave.
- "Persona still" (`lib/production/cast.ts:19`, a retired earlier-account model label) and the connected-catalogue renames "Persona" (`lib/vendorNames.ts:104-105`): neutral already, but the word is Persona, not Identity. One-line change if the owner wants Identity.
- "Astra render" in `lib/usageLedger.ts:117` (`meteredEngine`, the ledger's name for a 3D render). The 6 Oct rule says "Astra" must not read anywhere except "Topaz Astra 2". Not in this task; flagged for whoever owns the Astra sweep.

## Proposed picks (for the owner to confirm)

1. **The identity still engine: "Identity render".** It already reads that way in the ledger and Cast; the families under it read "Identity still · Standard / 2 / Cinema" (already shipped, tests pin them). One word for the thing, "Identity", that the owner chose for Soul everywhere else (README section 7). Alternative: "Identity still" for the whole group, to match the family names.
2. **The product/campaign still engine: "Product image".** It says what the person gets. Caveat: the Ads card also says "one branded still from the product image" meaning the person's own source photo, so the two could blur in a sentence. Alternative: "Campaign image". Either is one line in `lib/uiNames.ts`.

## Update 6 Oct, after the owner's answers

Both picks confirmed: Identity render and Product image (1dfccd24, pushed). Also done (commit 014e45b0, pushed):

- **Marketing Studio** reads **Product image** wherever a person reads it: the old Moleculr page and its section nav label ("Ads sections"), the old Gen dialog ("Product image build"), errors in `lib/generationAdmission.ts` and `lib/higgsfieldMarketing.ts`, `lib/renderWork.ts`, `app/api/**` presets and quote errors, Atomik's key-step problems, the old suite and page label tables (`lib/suites.ts:78`, `lib/workspace/pages.ts:78`), the Run dialog, the export heading. Where a name would read wrong it is plain words: "in one place" (marketing site and `SuiteHome`), "ad templates", "Ad video" (`lib/shell/business.ts`), "your ads" (phone accordion).
- **Persona** reads **Identity**: `lib/production/cast.ts:19` ("Identity still · A new identity from words alone."), `lib/vendorNames.ts:104-105`.
- The names check (`tests/helpers/uiStrings.ts`) now bans Persona and "Marketing Studio" / "marketing studio" in UI strings, with failing-sample tests (`tests/unit/ui-names-guard.spec.ts`), and the zero-tolerance test covers them. Internal ids (`marketing-studio-image`, `soul_cast`, `plan.role === "Marketing Studio"` comparison) stay.
- Collision to know about: the Ads board already has a "Product image" control (the product's own reference photo picker). The engine is now also called Product image, so one old browser test needed an exact-label match. If the owner wants the two apart, the engine name is one line in `lib/uiNames.ts` (Campaign image was the alternative).
