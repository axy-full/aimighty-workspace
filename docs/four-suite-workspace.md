# Four-suite workspace

The September 2026 four-suite design brief reorganizes the existing application. The current engines, prices, tenant boundaries, approval gates, recovery records and original media remain authoritative. No provider is connected merely because it appears in the design brief's proposed API map.

## Navigation and existing workflows

| Suite | Pages | Existing implementation |
| --- | --- | --- |
| Particl Production Studio | Brief & Script, Boards, Cast & Elements, Astra blender, Rig, Takes, Edit & Sound, Deliver | The workbench stages, with their original stage IDs and project save/recovery behavior. Eight visible stages since the 19 September restructure (PR A); see the alias table below. |
| Atomik Super Agent | Runs, Recipes, Approvals, Budget, Models | Durable pipelines, exact saved-plan cloning, per-stage priced approvals, settled job accounting, project caps, existing thinking model and effort controls. |
| Moleculr Business Suite | Marketing Studio (one page with the sections Product, Brand, Cast, Format, Variants, Design, Publish) | Project references, Soul identities, Marketing Studio, the existing generation dialog, original takes, edit and delivery tools. |
| Subatomik Viral Studio | Motion Transfer, Object Swap, Creative Directions, History | Genjutsu through Cloud and connected-account routes, shared originals, reviewed quotes, frame extraction, comparison, recreation and editorial handoffs. See [the Genjutsu contract](subatomik-genjutsu.md). |

### Particl stage order and retired stage IDs (PR A, 19 September 2026)

The dock shows exactly, in this order: Brief & Script, Boards, Cast & Elements, Astra blender, Rig, Takes, Edit & Sound, Deliver. No engine feature changed and no panel was removed; three stages were merged into their neighbours and keep their IDs as aliases so saved projects, agent tools and old links continue to work:

| Retired stage ID | Opens | Where its panel lives now |
| --- | --- | --- |
| `script` | `brief` (Brief & Script) | The script panel, development flow and OCR import render under the brief on the same stage. |
| `moodboard` | `storyboard` (Boards) | The Look panel is a collapsible "Look" section at the top of Boards. |
| `elements` | `characters` (Cast & Elements) | Cast is listed first, then Elements, each with its own upload tile and identity control. |

`?stage=script`, `?stage=moodboard` and `?stage=elements` normalise client-side (`normalizeStage` in `lib/workbench/studio.ts`, `PARTICL_STAGE_ALIASES` in `lib/suites.ts`) and the URL is rewritten to the visible stage. Takes lists project uploads and the project's generations together (the same library component Make uses, scoped to the project) and keeps the "All workspace assets" link. The Soul ID control is labelled "Identity" in the studio; the identity component and API are unchanged.

Moleculr's single page is `page=marketing`. Former page links (`page=brand`, `page=product`, …) normalise to `page=marketing#<section>`; `suiteHref("moleculr", id, "brand")` produces that form. The home route lists the project selector (recent projects, open a saved project, new project) before the suite cards and the brief textarea.

The shared shell includes a suite selector, project context, credits and account access, All assets, a resizable Atomik rail, and the appropriate bottom page dock. Particl retains its Projects, Production, Make, Library and Workspace room rail. Billing and account security use the same navigation without changing authentication or payments. The home route presents the four suites and saved projects instead of redirecting to the workbench.

`project` in suite links is always a private workbench draft ID. Atomik resolves its stored `productionProjectId` before reading pipeline and accounting data. Existing production-ID routes remain available. Changing suites from the workbench drains pending saves and blocks navigation on unresolved writes. Stage links have no actionable URL until hydration and initial project loading finish.

## Campaign persistence and generation

The optional `project.moleculr` object stores product details, up to five product image IDs, six cast image IDs, nine supported creative-format choices, twelve hooks and one hundred variant bindings. Old project documents remain valid; no database migration is required.

Configuring a variant creates or updates a generation node. Selected original images are bound through saved source nodes so a reload or handoff to Rig retains product and Soul references. Source selection uses the current draft's canonical image records. Locked generation nodes cannot be reconfigured, coordinates remain within the saved canvas bounds, and source additions respect the 250-node project limit atomically.

The existing generation dialog owns engine selection, explicit first-frame choice, quotes, paid confirmation, project/shot mapping and idempotent recovery. Configuration itself does not dispatch generation. Campaign takes are identified by their node binding and can be downloaded as originals or added to the existing edit. Marketing output continues to use the existing scoped planning and export flows.

## Capability boundaries

- Product URLs are saved references, not a claim that a storefront was scraped.
- Subatomik's creative directions are Particl prompt starting points. The official Genjutsu motion gallery is linked; no live gallery or trend feed is invented.
- Score shows editorial decisions and approval checkpoints, not an invented engagement prediction.
- Publish and Schedule lead to review and delivery. Social accounts and posting/scheduling providers are not connected by this release.
- Make retains the current saved-project requirement. It does not silently create unfiled paid work.
- The existing subscription and credit model remains unchanged. Stripe is outside this change.

Legacy `/subatomic` links redirect to `/subatomik` while preserving project context. Creator controls and recovery records remain scoped to the account and selected project.

## Validation

Focused unit coverage includes suite route identity, backward-compatible campaign persistence, bounded input, prompt constraints, source ownership, saved reference roundtrips, graph capacity, exact free recipe cloning, and truthful cost/status reporting. Browser coverage exercises phone, short landscape and desktop navigation, save failure guards, campaign generation configuration, reload into Rig with the same references, marketing exports, recipe/budget/model controls, and research draft recovery. Existing screenplay import, editorial version/export and generation recovery tests continue through the new dock.

Provider responses in browser tests are mocked or use the isolated local mock environment. These checks do not constitute qualification of a new external provider, live content feed or publishing integration.
