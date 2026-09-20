# The workspace switch-over

**Status: prepared, not enabled in production. Awaiting the owner's go-ahead.**

The redesigned workspace has lived at `/workspace` since PR223 while `/`,
`/workbench`, `/atomik` and `/subatomik` kept rendering the old shell. This
change makes the redesign the surface a desktop lands on from those four entry
points. Phones keep exactly today's surfaces. Every old URL still works, and
the old shell is one click away for one release.

## What changed, in one paragraph

Each of the four old entry points now renders a gate around the old shell. On
a desktop the gate replaces the URL with the `/workspace` URL that old URL
means; below 760px — and on a touch phone held landscape — it renders the old
shell and never touches the URL. The mapping is pure and lives in
`lib/workspace/switchover.ts`; the device half is
`components/switchover/SwitchoverGate.tsx`.

## Route mapping

`project` and every other query param survive. A page id is translated; a
Moleculr section becomes the hash, which is where Marketing Studio already
reads it from.

| Old URL | New URL |
| --- | --- |
| `/` | `/workspace?suite=particl` (home) |
| `/workbench` · `/workbench?project=X` | `/workspace?project=X&suite=particl` (home) |
| `/workbench?stage=brief` | `…&suite=particl&page=brief` |
| `/workbench?stage=storyboard` | `…&page=boards` |
| `/workbench?stage=characters` | `…&page=cast` |
| `/workbench?stage=astra-blender` | `…&page=astra` |
| `/workbench?stage=canvas` | `…&page=rig` |
| `/workbench?stage=assets` | `…&page=takes` |
| `/workbench?stage=edit` | `…&page=edit` |
| `/workbench?stage=export` | `…&page=deliver` |
| `/workbench?stage=script` · `moodboard` · `elements` | `brief` · `boards` · `cast` (already aliases) |
| `/workbench?suite=moleculr&page=marketing` | `…&suite=moleculr&page=marketing` |
| `/workbench?suite=moleculr&page=<section>` | `…&suite=moleculr&page=marketing#<section>` |
| `/atomik` | `…&suite=atomik&page=runs` (the old default page) |
| `/atomik?page=X` | `…&suite=atomik&page=X` |
| `/subatomik` | `…&suite=subatomik&page=motion` |
| `/subatomik?page=motion-transfer` | `…&page=motion` |
| `/subatomik?page=object-swap` | `…&page=swap` |
| `/subatomik?page=shorts` | `…&page=shorts` |
| `/subatomic?…` | as `/subatomik` (it already redirected there) |

Both directions are translated: `legacyPageId()` and `legacyShellHref()` map a
workspace page back to the legacy route the escape hatch opens.

### Why a client redirect rather than rendering the new shell at the old path

The decision depends on the viewport, and a server cannot see one, so a plain
`redirect()` in the old page could not honour "phones keep today's surfaces".
Rendering the new shell **at** `/workbench` would have left two different
surfaces answering one URL, and every Playwright spec asserting the old shell
would have had no way to ask for it. So the old path keeps rendering the old
shell, and a client gate calls `router.replace` on a desktop:

- **Bookmarks** keep working — the old URL resolves, then lands on the page
  that holds its work.
- **The back button** is sane, because `replace` does not add a history entry:
  going back from a switched page returns to wherever the person was, not to
  the old URL and forward again.
- **Existing specs** stay honest: they ask for the surface they assert through
  `tests/helpers/legacyShell.ts`, which seeds the cookie on **that page's own
  browser context** and returns the URL unchanged, so their assertions are
  untouched. A spec driving a second context has to seed that context.

## Phones and small viewports

One definition of "not a desktop", shared by `/workspace` and the gate:

```
(max-width: 759px), (hover: none) and (pointer: coarse) and (max-height: 500px)
```

Below that, the old shell renders at the old URL and `/workspace` itself hands
a phone back to `/workbench` (as it already did). Between 760 and 1100 the new
shell renders and scrolls horizontally, per the design rule.

Before the browser has answered, `components/switchover/switchover.css` decides
from the same query, so a desktop never flashes the old studio and a phone
never flashes the hand-off note.

**The answer is latched to the document** (`lib/workspace/device.ts`), and it is
taken while the document *parses* — by an inline script in the server-rendered
HTML, next to the `?shell=` cookie script and for the same reason. Taking it at
first render means taking it at hydration, and hydration is not a fixed point: on
a cold dev compile it lands many seconds after the document was readable, so the
decision would be made from whatever the viewport had become by then rather than
from what the person opened. Parse time is also exactly when
`components/switchover/switchover.css` decides the first paint from the same
query, so the two halves of the gate can no longer disagree. The latch reads that
record; the live query is only the fallback for a document that never parsed one
of these pages (a soft navigation), and its answer is recorded too. It has to: the second
clause is a *height* on a touch phone, and that height moves while nobody
rotates anything — a keyboard closing, browser chrome collapsing,
`interactive-widget=resizes-content`, a dev overlay. Re-deciding is not
re-styling here; it replaces the document, so a landscape phone that crossed
500px mid-session was being redirected into the desktop workspace while
somebody was using the phone surface (and, arriving late, it clobbered whatever
navigation had happened since). A rotation that reloads the page decides
freshly, because that is a new document; only a live media-query change inside
one document is ignored. `/workspace`'s own shell choice
(`MOBILE_QUERY`, `components/workspace/WorkspaceApp.tsx`) is deliberately NOT
latched: it only chooses which shell to draw, and the shell must match the
viewport it is drawn in, so it stays live.

## The escape hatch

For **one release**:

- `?shell=legacy` on any of the four entry points renders the old shell and
  leaves the URL alone.
- The choice is remembered in a `particl_shell=legacy` cookie for 30 days,
  because the old shell's own links (`suiteHref`) carry no `shell` param — a
  second click would otherwise bounce the person back out.
- The cookie is written by an inline `<script>` in the server-rendered HTML
  (`shellCookieScript`), not only by an effect, so the choice is remembered
  while the document parses rather than whenever hydration happens to finish.
  The effect stays as the path for a soft navigation that never re-parsed the
  document. Both write the same two constant strings; nothing from the URL
  reaches the script, and there is a unit test that says so.
- `?shell=new` cancels it and clears the cookie.
- The new shell's account menu carries **Use the previous workspace**, which
  opens the same project and page in the old shell.

### The kill switch

`WORKSPACE_IS_DEFAULT` in `lib/workspace/switchover.ts`. Set it to `false` and
every old entry point renders the old shell again exactly as before: no
redirect, no gate, no cookie read. `/workspace` stays reachable by its own URL.
Nothing else needs editing.

### Removing the hatch

When the old shell is retired: drop `SHELL_PARAM`/`SHELL_COOKIE` handling, the
`THIS RELEASE` group in `components/workspace/AccountMenu.tsx`, and the
`?shell=legacy` calls in the specs that assert the old surface.

## What only the old shell can still do

These are reachable, but not from a new-shell page. Each keeps its old route;
the ones marked **menu** are linked from the new account menu.

| Flow | How it is reached now |
| --- | --- |
| New project dialog | `/workbench?new=1` — `new` is a legacy-only param, so the old shell renders. Linked from the workspace Home's **New project**. |
| Marketing Studio mounted flow | `?atomik=marketing` is legacy-only; the `marketing` page also links out per section. |
| Old workspace home | `?view=workspace` is legacy-only. |
| Final-movie renderer | `/workbench/movie` — outside the four entry points, untouched. The `deliver` page mounts `MovieExport` inline. |
| All assets / library | `/library?all=1` — **menu** |
| Gen (standalone composer) | `/generate`, `/make/*` — **menu** |
| Productions and its deep screens | `/productions/*` — **menu** |
| Pipelines | `/pipelines` — **menu**, and already linked from the project header |
| Settings, engines, keys | `/settings`, `/settings#engines` — **menu** |
| Team, Usage, Credits & plan | `/team`, `/usage`, `/billing` — **menu** |
| Project admin: caps, share/review links, delete | `/projects/[id]` |
| Per-item screens | `/shots/[id]`, `/takes/[id]`, `/elements/[id]`, `/canvas/[id]`, `/rig/*` |
| Atomik development sub-routes | `/atomik/ideas`, `/atomik/treatment`, `/atomik/breakdown`, `/atomik/shots` |
| Admin, platform, connect, statements | `/admin`, `/platform`, `/connect`, `/statements/[month]` |
| Legal and report pages | `/policy`, `/privacy`, `/terms`, `/report` |
| Keyboard-shortcuts dialog (`?`) | old shell only; the new shell has the status-bar legend |
| Publish project bible / publish one asset | old shell only |
| Download project data (JSON) | old shell only |
| Add a reference link (URL as reference) | old shell only |
| Asset bins | old shell only |
| Rig node creation and auto-arrange | old shell only; `RigInspector` links out |
| Sequence colour, Edit versions | old shell only |
| Studio guide, redesign source download | old shell only |
| Welcome / first-run flow, Explore sample | old shell; visitors are never switched |
| Mobile handoff (phone header, stage pager, phone dock) | by design — phones stay on `/workbench` |

Closed as part of this change, because the new surface is now the default one:
the account menu itself (settings, team, usage, workspace switch, create
workspace, sign out), the suspended-workspace notice, `⌘J` for the Atomik
panel, and the `DialogHost` / `ContextMenu` / `UploadRecovery` hosts, which the
embedded old panels need and `/workspace` did not mount.

## Not in this change

No paid flow, quote or approval path, tenant scoping or credit logic was
touched.
