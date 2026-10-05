# UI checks: banned names and priced buttons

Two checks keep the old structure and unpriced spending out of the interface. Both are unit or browser specs that run in CI.

## 1. Banned names (`tests/unit/ui-names-guard.spec.ts`)

Reads every string a person can read in `app/`, `components/` and `lib/`: JSX text, string and template literals (⌘K and palette data, tab and page label tables, page titles, the phone bar, marketing navigation), and `public/manifest.json`. It fails on any of: Moleculr, Subatomik, Rig, Genjutsu, Soul, Higgsfield, "Gen" as the name of a place, "Generate" as a navigation label, "Astra" unless the same string names Topaz, the old suite phrases (Five suites, Production Studio, Business Suite, Viral Studio, Open in Gen…), and the same words in capitals.

Never read as UI: comments, identifiers, imports, comparisons, case labels, property keys, types, `className`, `id`, `href` and `data-*` values, and model names like Runway's "Gen-4". Exempt files: `design/particl-graphite/`, `docs/handoff-diff.md`, `docs/handover-2026-10-05.md`.

- **Strict surfaces** (`tests/helpers/uiSurfaces.ts`) allow nothing: the shell and avatar menu, ⌘K, tab, page and header labels (`lib/shell/**` and the old suite and page tables), the phone bar and phone screens, the marketing site and navigation, page titles in any file (`metadata`, `generateMetadata`, `document.title`, `<title>`), the manifest, and the new design's own directories (`components/graphite/{home,board,make,settings,control-room,phone}/`, `atomik/panel/`).
- **⌘K is checked twice.** Its files also ban Business and Viral as suite names and 01 to 07 stage numbers. And a test builds the palette's rows (`paletteIndex`) and requires exactly the design's items: Home; the board's regions; Ads and Social; Make; Atomik; the Settings sections; and, from the owner's fix 4, Make's modes (Motion transfer and Object swap among them) and Atomik's four places.
- **Until D0 lands**, what the D0 pull requests have not yet removed is allowed per file in the ratchet file's `strict` and `titles` sections (`by: D0 …`, `until: 2026-10-08`), and the ⌘K list test has a dated waiver in `tests/unit/ui-check-waivers.json`. A strict file with no allowance has an allowance of zero, so a new name fails at once; after `until` the file must be at zero. The check is green on main and cannot get worse.
- **Ratchet** (`tests/unit/ui-names-ratchet.json`, section `ratchet`): every other old-screen file keeps its count, which only goes down. Each entry has `until` (the date its screen is deleted, from `docs/old-design-inventory.md`) and `by` (who deletes it). After `until` the file must be at zero.

After removing names: `UPDATE_UI_NAMES_RATCHET=1 npx playwright test tests/unit/ui-names-guard.spec.ts --project=unit` lowers every section (never raises it, never adds a file); delete the ⌘K waiver once the new palette is in. The older `one-design-guard.spec.ts` test (c) stays and counts the original word list.

## 2. Priced buttons

Every control that can spend credits carries `data-spend` and shows its price: "N cr", "up to N cr", "about N cr, at most 3N cr" or "free". With no price yet it is disabled with `data-spend="unpriced"`. (`data-priced` is the older styling hook for a price in a button; it is not the marker.)

### How a new paid button opts in

```tsx
import { SpendButton } from "@/components/graphite/SpendButton";
<SpendButton label="Make" price={quote ? { cr: quote.credits } : null} busy={submitting} onClick={make} className="gx-primary" />
// renders "Make · 43 cr"; disabled until there is a price
```

Or, on a button you already have:

```tsx
import { spendAttrs, priceLabel } from "@/lib/spend";
<button type="button" {...spendAttrs(price)} onClick={run}>Transfer motion · {priceLabel(price)}</button>
```

`price` is the server's quote: `{ cr }`, `{ upTo }`, `{ cr, atMost }` (Cinema Studio), `"free"`, or `null`. Never invent a figure. The same applies to menu items ("Recreate · 3 cr") and links that start paid work.

### What is checked

1. **Closed route list** (`tests/helpers/paidRoutes.ts`, `tests/unit/spend-buttons.spec.ts`). `PAID_ROUTES` lists the routes a press can spend on. Any `app/api/**/route.ts` whose source carries a spend marker (`maxCredits`, `quoteOnly`, `withGenerationRequest`…) has to be in `PAID_ROUTES` or in `NOT_SPENDING` with a reason. Adding a paid route without deciding fails.
2. **Paid call sites** (`tests/helpers/spendScan.ts`). A string that names a paid route puts its top-level declaration on the paid path; so does using such a declaration, across files and through hooks. Rendering a component does not carry the path, and neither does reading a table. Each component file with a button on the paid path must contain `data-spend`, `spendAttrs(` or `<SpendButton`.
3. **Spend verbs.** A button whose own label starts with Make, Generate, Render, Release, Recreate, Again, Upscale, Transfer motion, Swap object, Train, Dub, Transcribe or Approve & run must carry `data-spend`.
4. **Rendered pages** (`tests/spend-buttons-workbench.spec.ts`, workbench config, five sizes). On each probed page: every `[data-spend]` shows a credit figure (or is disabled-unpriced or busy); no visible button with a spend verb lacks the marker; pages known to carry a paid control have at least `minSpend` of them. The probe list is data: edit a path when a screen moves.

**Strict and dated.** (2) and (3) count gaps per file: 1 for a file on the paid path with no marker, plus 1 per unmarked spend-verb button. The D0 surfaces (`tests/helpers/spendSurfaces.ts`: the Make panel and quick tools, the model sheet, Make › Recent, the right-click menu, the board's paid actions, including new files in `components/graphite/board/`) are strict: zero allowed, except what D0 has not fixed yet, per file, in the `strict` section of `tests/unit/spend-ratchet.json` (`by: D0`, `until: 2026-10-08`). Every other file is in the `ratchet` section with a count, a date and an owner from the inventory (Thu 8 Oct for what the board PR deletes). Counts only go down and a new file starts at zero; after `until` the file must be clean. After marking a button: `UPDATE_SPEND_RATCHET=1 npx playwright test tests/unit/spend-buttons.spec.ts --project=unit`. The rendered-page probes carry the same dated allowance (`allowedUnmarked`, `minSpend`, `until` in the spec).

Limit of (2): static analysis cannot see which handler a prop hands to a child, so the opt-in is per file at the place the paid call is wired. A child that receives a paid handler as a prop marks its own button (3 and 4 catch the ones that are labelled or rendered).

If a file reaches a paid route without a button that spends (a quote-only reader, say), do not weaken the check: move the paid call behind the button's own component, or add the route to `NOT_SPENDING` with the reason if it truly does not spend.
