# Old pages still reachable in Release 1 (read-only audit)

Audited on `origin/release/1` (9d67e09b), 6 Oct 2026. Private notes; not for the repo. Nothing was deleted or changed. Owner's rule: one design only; old pages should not be reachable in Release 1.

Method: every `page.tsx` under `app/`, `proxy.ts`, `lib/workspace/switchover*.ts`, `lib/shell/{ia,screens,settings,make,stage-redirects}.ts` and the screen routing modules, `docs/old-shells.md` and `docs/old-design-inventory.md` §4, plus a grep of every link from the new shell and from the old pages to old routes. Test counts come from `docs/old-shells.md` and may be a little stale.

## How old pages are reached today

- **Switch-over (`lib/workspace/switchover.ts`)**: a signed-in member with a workspace is redirected from `/`, `/workbench`, `/atomik`, `/subatomik` (and `/subatomic`) to `/suites`. It is skipped for `?shell=legacy` (or the `particl_shell=legacy` cookie), and for the legacy-only params `new`, `atomik`, `view`. So **`?shell=legacy` on any of those four routes still serves the whole old shell** (`WORKSPACE_IS_DEFAULT = true` is the only switch; setting it false restores the old shell everywhere).
- **Never redirected**: `/workspace`, `/workbench/movie`, and every other route under `app/(app)/` (the table below). They render their old page to anyone who types the address, signed in or not (the `(app)` layout is open to visitors by design; the API is what is closed).
- **`/suites` itself** still holds a few old in-shell pages, reached by address only (section 3).
- Old pages link to each other (the `(app)` layout wears the old header and account menu), so one stray link keeps a person inside the old design.

The new shell itself links out to old pages in only these places:

| From | Link | Old page |
|---|---|---|
| Header avatar menu, Workspace view | "Platform desk" (`SettingsMenu.tsx:66`, `WorkspaceView.tsx:124`) | `/admin` (platform owner only) |
| Workspace view and Settings, Connections row (`ConnectRow.tsx:28`) | "Tools and tokens" row | `/connect` |
| Settings › Team (`TeamSection.tsx:156`) | two-step "Change" | `/team` |
| Settings › Plan & credits and Workspace view (`CreditsSection.tsx:194`, `WorkspaceView.tsx:520`) | monthly statement "Open" | `/statements/[month]` (printable) |
| Project picker fallback (`ProjectHead.tsx:99`) | "New project", only when the host gives no `onCreate` | `/workbench?new=1` (the legacy-only param: lands in the OLD shell) |

⌘K (`lib/shell/palette.ts`) links to no old route.

## 1. Routes outside `/suites`

Recommendation key: **DELETE** = its job is done by a new screen and the address can 404 (or be a plain redirect); **REDIRECT** = send the address to the new screen; **KEEP** = no new screen, or must stay public or signed-in.

| Route | Reached by | What it is | Recommendation |
|---|---|---|---|
| `/workspace` | address only (and the old "Use the previous workspace" menu item, `components/workspace/AccountMenu.tsx:145`) | The redesigned September workspace shell (`WorkspaceApp`, with the whole phone `components/workspace/mobile/**` set). A visitor gets the public page (`proxy.ts` rewrite). | **REDIRECT** signed-in to `/suites` (keep the visitor rewrite to the public page). Then delete `WorkspaceApp`, `components/workspace/mobile/**`, the "previous workspace" link and cookie. |
| `/workbench` (and `?stage=`, `?suite=moleculr&page=`) | switch-over target of old links; `?shell=legacy`; `?new=1`; Gen's and Feed's "Open Studio" links; `AccountSecurity` | The old Studio shell (`Studio.tsx`, `production-graph.tsx`). | **REDIRECT** to `/suites?project=<id>` always, with the stage table that exists (`lib/shell/stage-redirects.ts`: `?stage=cast` → `?view=board&region=cast`, etc.; `?suite=moleculr` → `?view=board&kind=ads`). Drop `?shell=legacy` and the legacy-only params. Fix `ProjectHead.tsx:99` first. Then delete `Studio.tsx` and its sheets. |
| `/workbench/movie` | address; the `?snapshot=` hand-off from pipeline runs (`lib/workbench/movie-handoff.ts`) | Movie export page. | **KEEP for now**: the Deliver card does not take the `?snapshot=` hand-off. Redirect to Deliver (`?view=board&region=deliver`) once it does (owner: no stream owns it). |
| `/` (app home, signed in) | switch-over | `SuiteHome` | Already redirects to `/suites`; visitors get the public site. **DELETE** `SuiteHome` page body after the `?shell=legacy` escape goes. |
| `/atomik` | switch-over; `?shell=legacy` | Old Atomik suite page (`AtomikSuite`). | **REDIRECT** to `/suites?atomik=1` (the panel); control room pages are `/suites?suite=atomik&page=approvals`, `runs`, `saved-skills`, `memory`. |
| `/atomik/ideas`, `/atomik/treatment`, `/atomik/breakdown`, `/atomik/shots` | address; links between themselves; `ideas` links to `/projects/<id>/canvas` | Older Atomik planning pages (ideas board, treatment, breakdown, shot list). No frame draws them. | **DELETE** (the Brief and Storyboard regions and the Atomik panel do the job). Owner to confirm: they hold saved treatment drafts. Nearest address for a redirect: `/suites?view=board&region=brief`. |
| `/subatomik`, `/subatomic` | switch-over; `?shell=legacy`. `page=shorts` already redirects to the suite's first page | Old Social/Viral page (`SubatomikWorkspace`). | **REDIRECT** to `/suites?make=motion` (Make › Motion transfer); `?make=swap` for Object swap; History is `/suites?view=board&kind=social&drawer=history`. |
| `/generate` | address; links from `GenWorkspace`, Library, redirects below | Old Gen page (`GenWorkspace`). | **REDIRECT** to `/suites?make=video` (image: `make=image`, audio: `make=audio`, same project param). Then delete `components/make/GenWorkspace.tsx`. |
| `/images`, `/audio`, `/make/[kind]` | address | Redirect pages to `/generate?mode=` (`lib/genRoute.ts`). | **REDIRECT** straight to `/suites?make=image`, `make=audio`, `make=video` (no chain through `/generate`). Unknown kind stays 404. |
| `/studio/shot` | address; Shot-builder hand-offs | Camera and shot builder; hands off to `/generate`. No frame draws it. | **DELETE** after `/generate` redirects (its output lands in Make). Owner to confirm: nothing replaces the camera/shot builder UI. |
| `/library`, `/all` | address; the old `(app)` header's Library toggle (`components/shell/Header.tsx`), Gen's "Library" link | Cross-production library wall. | **REDIRECT** to `/suites?make=recent` (Make › Recent) for a person's work, or `?view=board&region=shots` with `project=<id>`. No cross-production lens exists in the new design (flag for owner). |
| `/productions` | address; old `(app)` header; `projects/[id]` back links; `Feed` | Productions and projects list with totals and caps. | **REDIRECT** to `/suites?view=home` (projects as cards). Totals and the caps page are not on Home: see `/projects/[id]`. |
| `/productions/[prod]/[project]/media`, `/shots` | links from `/productions`, `/projects/[id]`, `Feed`, rig pages | Per-project Takes and Shots lists. | **REDIRECT** to `/suites?project=<id>&view=board&region=shots`. Needs the production→workbench project id mapping first. |
| `/projects/[id]` | address; `Theatre`, `Feed` ("Spend & cap") | Per-project cost overview with the spend cap. | **KEEP for now**: it is where a project's spend and cap read today (not checked whether the new Settings › Spending rules covers a per-project cap). Not drawn. Money behaviour: leave for the owner. |
| `/projects/[id]/canvas`, `/canvas/[id]` | address; `Feed`, `atomik/ideas` | Sequence wall (refs / wall / time); `/canvas/[id]` is a redirect to it. | **REDIRECT** to `/suites?project=<id>&view=board`. |
| `/projects/[id]/rig/elements` | address | Element versions and the impact panel. | **REDIRECT** to `/suites?project=<id>&view=board&region=cast`. Version-swap impact has no new equivalent (flag). |
| `/rig/canvas/[boardId]` | address; Library "Add to Canvas", productions Shots "Open in Rig" (`/rig/canvas/new?project=…`) | The old Rig canvas (976 lines). | **REDIRECT** to `/suites?project=<id>&view=board` (the Board). Imports of old boards (`lib/workspace/rig-import.ts`) must be resolved first. |
| `/rig/recipes/[projectId]` | address; Rig canvas "recipes" button | Recipes list. No frame draws it. | **DELETE** (Rig canvas goes with it). |
| `/rig/run/[runId]` | address | Redirect to `/pipelines`. | **REDIRECT** to `/suites?suite=atomik&page=runs` (Control room › Activity). |
| `/pipelines` | address | Pipeline builder and runs (`PipelineWorkspace`). | **REDIRECT** to `/suites?suite=atomik&page=runs`. |
| `/takes/[id]`, `/shots/[id]`, `/elements/[id]` | address; `productions/.../media` links to `/shots/[id]`; Rig element list links to `/elements/[id]` | Provenance card, shot bindings, element screen. No frame draws them. | **KEEP for now** (provenance and bindings are the audit trail; owner to say). Nearest redirect if dropped: Inspector on the board, `?view=board&region=shots`. |
| `/settings` | address; old `(app)` account menu; `?view=workspace` tab links (`WORKSPACE_TABS` hrefs) | Old workspace settings (904 lines; Higgsfield connection component still imported). | **REDIRECT** to `/suites?view=workspace&tab=advanced&open=workspace`. Then delete. |
| `/team` | address; "Change" two-step in new Settings | Old People and Security page. | **REDIRECT** to `/suites?view=workspace&tab=team` (security: `&open=security`). Fix `TeamSection.tsx:156` to link the Settings fold, not `/team`. |
| `/usage` | address; old account menu | Old Usage page (1019 lines). | **REDIRECT** to `/suites?view=workspace&tab=credits&open=usage`. |
| `/dashboard` | address | Redirect to `/usage`. | **REDIRECT** to `/suites?suite=atomik&page=runs`. |
| `/connect` | address; `ConnectRow.tsx:28` in the new shell | Tokens and setup page (`Tokens.tsx`). | **REDIRECT** to `/suites?view=workspace&tab=connections`; verify the new Connections section covers tokens, then change `ConnectRow` and delete. |
| `/statements/[month]` | new Settings and Workspace view ("Open") | Printable monthly statement. | **KEEP** (no frame; linked from the new Settings). |
| `/admin` | avatar menu "Platform desk" (platform owner only) | Platform desk. | **KEEP** (admin-only; the owner's tool). |
| `/platform`, `/report` | `/settings` page; policy and privacy pages | Platform answers page; public abuse-report form. | `/platform` **KEEP** (platform owner; goes with `/settings` link otherwise). `/report` **KEEP** (public, legally needed). |
| `/policy`, `/privacy`, `/terms` | sign-up, invite, footer links | Public legal pages. | **KEEP** (public). They sit inside the old `(app)` layout (old header). Moving them out of that layout is the one change to make before the layout is deleted. |
| `/review/[token]` | client review link | Client review page. | **KEEP** (public link). |
| `/login`, `/signup`, `/reset`, `/invite/[code]`, `/setup`, `/welcome`, `/account/security`, `/billing`, `/pricing` | auth flow | Sign-in and account. | **KEEP** (sign-in, money and accounts wait for the owner). |
| `/site/*` pages (`/studio`, `/business`, `/viral`, `/atomik`, `/workspace`, `/pricing` for visitors) | public site (`proxy.ts`) | The marketing site, under old suite names in its URLs. | **KEEP** for now (copy and guest Home belong to stream 15). `/business` and `/viral` are the old names in addresses: rename or redirect to `/ads` and `/social` when the owner decides. |

## 2. The two shells you can still force

- `?shell=legacy` and the `particl_shell=legacy` cookie (`lib/workspace/shell-choice.ts`, `switchover.ts`, `SwitchoverGate`, `components/workspace/AccountMenu.tsx`). **DELETE**: it is the single switch that brings the whole old shell back for `/`, `/workbench`, `/atomik`, `/subatomik`. Removing it (and `LEGACY_ONLY_PARAMS`) is what makes the rows above true.
- `WORKSPACE_IS_DEFAULT` (the kill switch): leave until the redirects land, then delete with `switchover.ts`.

## 3. Old pages inside `/suites` (address only)

All reached only by a typed or saved address; `redirectFor`, `fromMakeLink` and each screen's `rows` already send most of them to the new screen.

| Address | What it draws | Recommendation |
|---|---|---|
| `?suite=moleculr&page=marketing[&sp=…]` | Old Business pages (`components/graphite/business/*`, `suites/MoleculrWorkspace`) | Already **REDIRECT**ed by `ads-social.ts` rows to `?view=board&kind=ads…`. **DELETE** the pages once the Ads board stops mounting `BrandTool`, `ProductTool`, `ReferenceTool`, `HooksTool` and `FormatTool` from there (`docs/old-shells.md`: the board still imports them). |
| `?suite=subatomik&page=history` | `ViralView` History | **REDIRECT**ed to `?view=board&kind=social&drawer=history`; `ViralHistory` is still imported by the Social board's drawer: keep that export, delete the page. |
| `?suite=atomik&page=…` (approvals, runs, saved-skills, memory) | Control room (new) | Not old: these are the new addresses. `page=agent`, `models`, `budget`, `skills` redirect to the panel and Settings sections. |
| `?view=workspace&tab=<old tab>` | `WorkspaceView` (old Workspace) | New Settings answers `tab=team|credits|rules|connections|advanced`. `WorkspaceView` still renders as the phone fallback (`SuitesShell.tsx:376`, `:411`). **DELETE** once the phone Settings draws the sections. |
| `?view=crew&cp=…` | `CrewView` | **REDIRECT**ed to `?view=board&frame=m` / `n` (`lib/board/routes.ts`); delete `CrewView` with the redirect kept. |
| `?view=gen` | `GenView` | **REDIRECT**ed to `?make=<type>`; delete `GenView`, `ModelSheet`. |
| `?suite=particl&page=brief&sp=stages|home` | `StudioHome`, `SuiteHome` (old phone and desktop Home) | **REDIRECT**ed to `?view=home` but still imported by `SuitesShell.tsx:52-53`; **DELETE** the two files and the imports. |

## 4. The old (app) shell itself

`app/(app)/layout.tsx` wraps every `(app)` route in the old `components/shell/Shell.tsx` (old header, `AccountMenu`, `Header`, `ViewportGuard`, old ContextMenu). As long as any KEEP row above sits under `(app)`, this old chrome is reachable. Recommendation: move the KEEP routes (`/admin`, `/platform`, `/report`, `/policy`, `/privacy`, `/terms`, `/statements`, `/projects/[id]`, `/takes`, `/shots`, `/elements`) to a plain minimal layout drawn with `app/graphite.css`, then delete `components/shell/**` and the three sheets it loads.

## 5. Suggested order (one PR each, each leaves no page broken or unstyled)

1. Remove `?shell=legacy` and the old "previous workspace" link; fix `ProjectHead.tsx:99`, `TeamSection.tsx:156`, `ConnectRow.tsx:28` to in-shell targets.
2. Redirect `/workspace`, `/workbench`, `/atomik`, `/subatomik`, `/generate`, `/images`, `/audio`, `/make/*` (the rows in section 1 marked REDIRECT with ready targets).
3. Redirect `/settings`, `/team`, `/usage`, `/dashboard`, `/connect`, `/pipelines`, `/rig/run/*`, `/library`, `/all`, `/productions`.
4. Redirect the ones needing an id mapping (`/productions/…/media|shots`, `/projects/…/canvas`, `/rig/canvas/*`).
5. Delete the dead components after each (their tests are listed in `docs/old-shells.md`; about 70 specs navigate the old routes and need to be rewritten to the new addresses or removed).
6. Owner decisions before deleting: project spend caps (`/projects/[id]`), provenance/bindings (`/takes`, `/shots`, `/elements`), cross-production library, Atomik treatment drafts, shot builder, `/workbench/movie` snapshot hand-off.

Notes for the lead: `docs/old-shells.md` and `docs/old-design-inventory.md` §4 are partly stale (they still speak of "the switch on/off"; on release/1 the new-interface switch is gone and every screen shows for everyone). The two inventory rows marked UNOWNED (`/workbench/movie`, `/studio/shot`, `/projects/…`, `/takes…`, `/atomik/ideas…`) are the ones still waiting on an owner decision.
