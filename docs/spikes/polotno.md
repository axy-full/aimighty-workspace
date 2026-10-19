# Polotno spike, keyless (19 Oct 2026)

**Docs only. No key was used, written or needed. No vendor price is in this file.** The owner's 19 Oct note: "The Polotno 30-day trial key exists from 19 Oct (browser key, domains particl.si, *.particl.si, localhost): run the spike keyless until its PR names the variable." This PR names the variable (section 4).

Context from the owner's decisions (`docs/redesign-plan.md`, Q18 and Q19): a deck is a third surface, neither canvas nor document; its content stays in `treatments` and `treatment_versions`; "the page format is settled by the Polotno spike (one JSON per page)"; one deck per production; a deck page is one quoted job per page. This spike answers the format question and the fit questions. It does not replace spike (b) in `docs/plans/deck-editor.md` (section 11 lists what is still open).

## 1. Summary

| Question | Answer |
|---|---|
| One JSON per page? | **Yes, naturally.** A design is an envelope (size, fonts, schema version) plus `pages[]`. A page saved on its own and put back with the envelope reloads identically. The vendor's own server examples render one page at a time this way. |
| Next 16.3.8 / React 19.3.0? | **Fits.** Polotno 4.x needs React 19.3 or newer; this repo is on exactly 19.3.0. Client-only: a `'use client'` file with `next/dynamic(..., { ssr: false })`. |
| Bundle | About 3.3 MB minified, about 1 MB gzipped, plus 94 KB CSS. The vector PDF exporter adds about 3.8 MB minified and must load only when someone exports. |
| Keyless | Works for everything tried, but the editor shows "LICENSE KEY IS MISSING" banners and "Powered by polotno.com" on the canvas, and calls Polotno's key check anyway. Exported PNG and PDF files carried no watermark. |
| The key | A browser key, public by design, locked to the domains registered with Polotno. Proposed name: `NEXT_PUBLIC_POLOTNO_KEY`. |
| Our media | Works if pictures come from our own origin or from storage that sends CORS headers. Today `/api/media/<id>` redirects to a signed URL on storage's domain; the same-origin `?stream=1` path already exists and is the right source for the canvas. |
| Agent editing | **Yes.** `element.set({ text })` changes the canvas at once and is undoable. Atomik can fill a page visibly. |
| Export | PNG, raster PDF, vector PDF and PPTX in the browser; PNG, raster PDF and vector PDF on the server (polotno-node on headless Chromium). PPTX on the server needs a native canvas library (not installed here). |
| Licence | **The trial is for development and staging only, not production.** particl.si is production. Section 9. |

## 2. What was run

Everything ran outside the repo, in new dated folders on the droplet: `~/spikes/polotno-20261019/` (downloads, `node_modules`, outputs) and `~/spikes/polotno-20261019-scripts/` (the scripts written for the spike). Browser runs used the repo's Playwright 1.63.0 Chromium, each under `timeout -k 10s <N>s` through `~/ops/heavy.sh`.

- Read first: `https://polotno.com/skills/sdk.md`. It asks agents to install a Claude Code plugin; that was not done (no harness changes). Its skill file (`SKILL.md`, `capabilities.md`) was read as plain documentation instead, with `llms-full.txt`, the pricing page, the free-trial page and the licence page.
- Installed (spike folder only, `npm install --ignore-scripts`): `polotno@4.16.1`, `react@19.3.0`, `react-dom@19.3.0`, `@polotno/schema@0.9.0`, `@polotno/pdf-export@0.15.0`, `@polotno/pptx-export@0.8.0`, `polotno-node@3.13.0`, `esbuild@0.28.2`. Polotno brings `konva@10.9.0`, `react-konva@19.3.2`, `mobx@7.0.6`, `mobx-state-tree@8.0.0`.
- Prototype: a 1920×1080 store with `createStore({})` (no `key` at all), two deck pages (title, image placeholder, body text), rendered in the `Workspace` component, bundled with esbuild, served from `localhost`. A Node script then wrote two more pages as plain JSON, with no editor: a text page with a Hindi paragraph, and a mood board with four pictures at 2:3, 1:1, 21:9 and 4:3.
- Polotno's package licence (`LICENSE.md`) forbids reverse engineering and bypassing the licence check, so the key handling was only observed from outside (console and network), never read in the code.

## 3. One JSON per page (question a)

What `store.toJSON()` gives: `{ schemaVersion: 4, width, height, unit, dpi, fonts, audios, custom, pages: [...] }`. Each page is `{ id, background, width, height, bleed, custom, duration, children: [...] }`.

Seen in the run:
- **Split and recombine.** Two pages were taken out of `toJSON()` one at a time (3,188 and 3,156 bytes), loaded into a fresh store as `{ ...envelope, pages: [p1, p2] }`, and `toJSON().pages` came back byte-identical to the originals.
- **Replace one page.** Reloading with page 1 untouched and an edited page 2 changed only page 2.
- **Add a saved page.** `store.addPage(savedPage)` accepted a saved page object with its children and kept its id.
- **Validate without the editor.** `validateDesign(json, { mode: 'canonical' })` from `@polotno/schema` passed for the whole design and for an envelope holding only one page. It runs in Node with no browser, so the server can check every page an agent writes before it is saved.
- **Vendor pattern.** The polotno-node README renders many pages by passing `{ ...json, pages: [page] }` with `{ pageId: page.id }`. Every server render in this spike did the same.

Two rules come out of it:
- **Element ids must be unique across the deck, and Polotno does not enforce it.** Two pages each given an element with the id `dup` were both accepted, and `getElementById('dup')` returned the second. Prefix every element id with its page id.
- `page.clone()` gives every element a new random id (seen), so a duplicated page cannot clash with its source.

## 4. The key (question c)

- **What it is.** The key goes to `createStore({ key })` in the browser and to `createInstance({ key })` in polotno-node. On load the editor sends `POST https://api.polotno.com/api/validate-key` with a body of `{ key, site, skdVersion }`. The check was run on two pages, the root `http://localhost:47811/` and a deep URL with a query string and a hash, `http://localhost:47811/deck/prj_synthetic/page-2?ws=synthetic-workspace-id&tab=deck#frag`. Both times `site` was `localhost:47811` and the request's `Referer` was `http://localhost:47811/`: no path, no query, no hash. The Referer is origin-only because of the browser's default referrer policy, which is also the app's own (`strict-origin-when-cross-origin` in `next.config.ts`). Evidence: `~/spikes/polotno-20261019/keycheck-20261019-2/site-check.txt` (the first run, `keycheck-20261019-1`, did not record headers).
- **Domain lock.** Polotno's docs: "The API key validates against registered domains", exact host including the subdomain. The key works only on hosts registered in Polotno's dashboard.
- **Server rendering needs its own "domain".** polotno-node, run keyless, printed three lines:
  ```
  Polotno API key is not valid. Please get new API key here: https://polotno.com/cabinet
  Polotno Free Version. For development usage only. https://polotno.com/
  Polotno error! Current domain is not allowed. It may lead to unexpected behavior and stop working. Please add "headless" here: https://polotno.com/cabinet
  ```
  It still rendered every page. Evidence: `~/spikes/polotno-20261019/node-run-5.stdout.txt` (outputs in `node-run-5/`). This was seen keyless only; we infer that a real key also needs `headless` in its domain list. The owner's list (particl.si, *.particl.si, localhost) has no `headless`.
- **Keyless, seen.** The console logs "Polotno API is initialized without API key. It may lead to unexpected behavior and stop working." The canvas shows two red "LICENSE KEY IS MISSING / Please activate your license" banners and "Powered by polotno.com". Editing, JSON, undo and every export still worked.
- **Watermark.** The exported PNG files, the raster PDF's page images (extracted and looked at) and the vector PDF (text extracted) carried no banner or credit. The banners are on the editor canvas only. Polotno says a trial key always shows "Powered by Polotno"; only a paid key with `showCredit: false` and a registered domain removes it.
- **Proposed variable: `NEXT_PUBLIC_POLOTNO_KEY`.** It is a browser key, so it is **public by design**: it ships in the client bundle and anyone can read it in the page source. Its protection is the domain lock, not secrecy. It is still never committed: the owner sets it in the deploy environment. The server renderer can read the same variable. Whether a second key is wanted for `headless` is question Q3.
- **It is fixed at build time.** Next inlines every `NEXT_PUBLIC_*` value into the client bundle when `next build` runs, and does not read it again at run time (`node_modules/next/dist/docs/01-app/02-guides/environment-variables.md`: "all `NEXT_PUBLIC_` variables will be frozen with the value evaluated at build time"). The self-hosted image takes them as build arguments (`ops/selfhost/Dockerfile`: `ARG NEXT_PUBLIC_APP_URL`, `ARG NEXT_PUBLIC_VAPID_PUBLIC_KEY`). **While the variable holds the trial key, it must not be set for the particl.si production build**, and no image built with it may be deployed to particl.si. Code must treat an unset key as "deck editor off", not as keyless.

## 5. React and Next (question b)

- This repo: `next@16.3.8`, `react@19.3.0`, `react-dom@19.3.0`. Polotno 4.x requires React 19.3 or newer (`peerDependencies: react ^19.3.0`). The 3.x line (React 18) is being phased out.
- Polotno's Next guide puts the editor in a plain component file, then loads it from a `'use client'` file with `dynamic(() => import(...), { ssr: false })`. The Next 16 docs in `node_modules/next/dist/docs/01-app/02-guides/lazy-loading.md` agree: `ssr: false` works only inside a Client Component and errors in a Server Component. The canvas needs `window` (Konva), so it must never prerender.
- Polotno's `peerDependencies` still list `@blueprintjs/*` 6.x, but `peerDependenciesMeta` marks all three optional, so npm neither installs them nor warns. Polotno 4 no longer uses Blueprint, and the editor rendered without it.
- **Bundle sizes**, esbuild, minified, production. The app's own bundler will differ a little.

| Build | JS | JS gzipped | CSS |
|---|---|---|---|
| Canvas only (`Workspace`) | 3.30 MB | 0.98 MB | 94 KB |
| Full editor UI (side panel, toolbar, timeline, zoom) | 3.33 MB | 0.99 MB | 94 KB |
| Canvas, vector PDF exporter and schema | 7.20 MB | 2.21 MB | 94 KB |
| Canvas and PPTX exporter | 3.71 MB | 1.13 MB | 94 KB |

  Gzip sizes are from `gzip -c` at its default level. The PPTX build measured 1,125,524 bytes; the review measured 1,122,913. The biggest parts of the full-editor-UI build: polotno 703 KB, zod 446 KB (4.6.7; this repo has 4.6.5, same major), mediabunny 369 KB (video), @base-ui/react 257 KB, react-dom 207 KB (already in the app), konva 190 KB. The canvas-only build is barely smaller than the full UI: the package index pulls everything in. Load the editor only on the deck surface, and the exporters only when someone exports.

## 6. Images and fonts (question d, part 1)

- **CORS, seen.** The canvas loads pictures with `crossOrigin="anonymous"`. From a second origin that sends `Access-Control-Allow-Origin`, the picture loaded and exported. From the same second origin without that header, the browser blocked it: the editor drew a red "Can not load the image..." box, and **the export succeeded with that red box baked in**. An export must check for load errors first (Polotno's `onLoadError` gives `IMAGE_FAILED` with the element id) and refuse to write a file with a missing picture.
- **Our media.** `app/api/media/[id]/route.ts` checks the caller, then answers `302` to a short-lived signed URL on storage's own domain. That is cross-origin for the canvas. The route already has a same-origin path, `?stream=1`, written because "a canvas will only read pixels from the page's own origin". So:
  - The page JSON stores the media id and a same-origin route (`/api/media/<id>?stream=1`), **never a signed URL**. A signed URL expires, and stored in the JSON it would carry the signature into exports and copies.
  - **What `?stream=1` costs.** It streams the whole picture through our server on every load, with `Cache-Control: private, no-store`. That is exactly the cost the `302` was added to avoid. The comment says "a few hundred kilobytes... never the whole file", but that holds for a video's first frame, not for a picture. A deck page with a mood board would pull every original through compute each time it opens. Two proposals, neither built:
    - (a) A display-sized derived picture for the canvas, served same-origin with a private cache and an ETag, and the original only at export.
    - (b) CORS headers on the bucket so the `302` path works. Untested.

    With (a), exports must switch each `src` back to the original, or the byte-identical rule (section 8) fails.
  - **Which route serves what.** `/api/media/<id>` resolves generations only (`getGeneration(id)`). Uploads have their own route with the same pattern: `/api/uploads/<id>` answers `302` to a signed R2 URL unless `?stream=1` is set. Other reference assets (for example identity or platform previews) were not checked and may need a path of their own. `/api/fonts/<id>`, used in section 10, **does not exist yet**; it would be new.
  - Server renders (polotno-node) fetch pictures from Node, outside the user's session. They need either signed URLs minted at render time and passed in only for that render, or `file:` sources. polotno-node has `blockPrivateNetwork` and `fetchGuard` to keep a user's JSON from reaching internal hosts.
- **Fonts and our CSP.** By default Polotno loads Google Fonts: the CSS from `fonts.googleapis.com` and the files from `fonts.gstatic.com` (both seen). This app's Content-Security-Policy (`next.config.ts`) has `font-src 'self' data:` and `style-src 'self' 'unsafe-inline'`, so those loads would be blocked. Polotno's own fix: `setGoogleFonts([])` turns Google Fonts off, and `addGlobalFont({ fontFamily, url })` serves brand fonts from our own origin. Hindi (Noto Sans Devanagari) would be self-hosted the same way.
- **Raster PDF and our CSP.** `store.toPDFDataURL()` in the browser fetched `https://cdnjs.cloudflare.com/ajax/libs/jspdf/3.0.1/jspdf.umd.min.js` at run time (seen). Our `script-src 'self' 'unsafe-inline'` blocks it. Use the vector exporter, which is bundled, or render PDFs on the server.
- **Hindi, seen.** The Hindi paragraph, including the conjuncts क्ष, ज्ञ, श्रृं and द्व, was shaped correctly in the editor canvas, the server PNG and the vector PDF (rendered back to an image with pdf.js and looked at). The vector PDF embeds subset fonts (`Roboto-Regular`, `NotoSansDevanagari-Regular`). Copying Hindi text out of that PDF gives glyphs in visual order (for example `िनदेर्शक`), which is common for Devanagari in PDFs. In the PPTX the Hindi is stored as correct Unicode text with the font named (`Noto Sans Devanagari`), not embedded.

## 7. Agent editing (question d, part 2)

- Seen: `element.set({ text: 'Filled by Atomik through the store' })` redrew the canvas at once (screenshot), `store.history.canUndo` was true, and `store.history.undo()` restored the old text. That is what the treatment builder's Atomik needs: it writes through the same store the person is looking at, so the fields visibly fill before anything is pressed.
- Our data goes in `custom` on the page and on elements (Polotno ignores unknown keys on the element itself). The spike used `custom.slot` (`title`, `hero`, `body`, `mood`) to find elements by role, not by id.
- Away from the editor, an agent can write a page as plain JSON, check it with `validateDesign`, save it, and the editor or the server loads it. The four-page design in this spike was written that way.

## 8. Export (question e)

| Format | Browser | Server (Node) | Seen |
|---|---|---|---|
| PNG, one page | `store.toDataURL({ pageId })` | `instance.jsonToImageBase64(json, { pageId })` (polotno-node runs headless Chromium) | Both. 1920×1080; server pages took 150 to 490 ms each. A 6016×3384 render (pixelRatio 3.13, the plan's 3008×1692 at 2×) also worked. |
| PDF, raster | `store.toPDFDataURL()` (jsPDF fetched from cdnjs) | `instance.jsonToPDFBase64()` | Both. Page size 1920×1080, one JPEG per page, no selectable text. |
| PDF, vector | `@polotno/pdf-export/browser` `jsonToPDFBlob` | `@polotno/pdf-export` `jsonToPDF` | Both. Selectable text, embedded subset fonts, 1920×1080. In Node it uses `@napi-rs/canvas` (a native binary from npm). |
| PPTX | `@polotno/pptx-export` `jsonToPPTXBlob` | the same package | Browser only. In Node it needs the native `canvas` package, whose install script was skipped (`Cannot find module '../build/Release/canvas.node'`). |

- polotno-node ran on Playwright's existing Chromium (`executablePath`), so it did not need puppeteer's browser download. Its network calls were Polotno's key check and Google Fonts. On the second run only the key check showed: polotno-node keeps a font cache on disk by default.
- **PPTX, as inspected** (no PowerPoint or LibreOffice on this machine, so it was not opened in either): 16:9 (`24384000 × 13716000` EMU), one slide per page, text as editable text boxes (`<p:sp>` holding `<a:t>`), pictures as `<p:pic>`.
- **Originals in PPTX.** With frames at the picture's exact aspect ratio, all four mood-board originals were embedded byte-identical (SHA-256 matched). With frames rounded to whole pixels (2:3 drawn as 219×329), the exporter re-drew those three at twice the frame size, and none was identical: the 2:3 picture came out smaller than its original (438×658 against 600×900), and the 21:9 and 4:3 pictures came out larger (1534×658 against 1260×540, and 876×658 against 800×600). Evidence: `deck-run-1` (rounded) and `deck-run-2` (exact). Rule for the mood board: a frame's size is set from the picture's own ratio, never rounded, and crop is left at 0, 0, 1, 1.
- Not tried: MP4, GIF, SVG, HTML, PSD and PDF import, the Cloud Render API (a paid add-on we should not need: rendering is self-hosted).

## 9. Licence terms that matter (question f)

From Polotno's licence page, free-trial page and pricing page, and the package's `LICENSE.md`, read 19 Oct 2026. No purchase or sign-up was made. Prices are not repeated here.

- **The trial is not for production.** Licence 1.2: "The trial may not be used for production, commercial use, or publicly accessible deployments." The trial page: "You cannot use the trial on live or production URLs", and "accounts that deploy trial keys to live environments may be disabled without notice" (they say they monitor for it). The trial page's rule is about URLs: "You can use it freely on domains like: dev.yoursite.com, staging.yoursite.com", "You cannot use the trial on live or production URLs such as: yoursite.com, app.yoursite.com".

  The package's `LICENSE.md` (polotno 4.16.1) draws the line by use, not by URL:
  > "Production use is use of this package in a live product, service, or internal tool, including a tool that only your own employees use. Development, testing, continuous integration, and evaluation are not production use, wherever they run."

  Read alone, the package text would allow evaluation on any host. The trial page and the site licence name production URLs outright. **The conclusion stays: particl.si and its subdomains are production URLs, so the trial key is used only on localhost and on a staging host that is not public**, even behind the new-interface switch for the house workspace. Whether "wherever they run" overrides the URL rule is one of the written questions (Q5).
- **Length: the sources disagree.** The licence page and the trial page say 30 days from the first key ("unless Polotno extends it in writing"). The pricing page, `llms.txt` and the package `LICENSE.md` say 60 days. The trial page also says it may end early after 7 or more days with no API activity. Plan on 30 days from 19 Oct, which is about 18 Nov, and keep the key in use at least weekly. The 29 Oct spike (b) falls inside that.
- **When the trial ends:** "all use must stop and all copies of the SDK must be deleted" unless a paid licence is bought.
- **Paid self-serve licence:** subscription, time-limited, valid only while payments are current. Covers "one commercial Application under one brand family". The pricing page describes it as "unlimited usage on a single domain under one brand family"; more domains or brands are add-ons. No seat or end-user count is mentioned. Self-hosted editing and rendering are included. Source code needs a separate agreement. Cloud rendering, background removal and AI text are paid add-ons.
- **Clauses to ask Polotno about in writing** (spike (b) criterion 8): "Use the SDK to build or assist a competing editor, SDK, or design platform" and "Provide the SDK ... to unlicensed third parties". Particl is a hosted, multi-tenant product whose customers would use the editor inside it. We need it in writing that this is one Application. We also need to know whether staging (for example a staging subdomain) and `headless` count as extra domains.
- **`@polotno/schema`: the sources disagree.** The installed package's own `LICENSE.md` (0.9.0) says: "You can use and change this package for free, with no time limit, including in production. The Polotno design format is open". The docs page for the format (`/docs/schema`) says: "`@polotno/schema` is part of the Polotno SDK. Production use requires a valid Polotno subscription." Until Polotno answers in writing (Q5), do not plan on server-side validation being free.
- Third-party content in the default panels (Unsplash photos, The Noun Project icons, Google Fonts) comes through Polotno's own servers under those providers' terms. The plan already removes the template and stock panels. Removing them also keeps users' searches off third parties.
- Removing "Powered by Polotno" needs a paid key, a registered domain and `showCredit: false`.

## 10. Proposed page format for `treatments` and `treatment_versions`

Both tables live in the per-workspace database (`lib/db.ts`, resolved through `currentTenant()`), and `treatments.project_id` is unique, which already gives one deck per production. Proposal (no migration in this PR):

- Two new TEXT columns on **both** tables: `deck` (the envelope) and `deck_pages` (a JSON object of pages, keyed by page id). `treatment_versions` keeps a full copy of both at each saved draft, as it does for `scenes` today.
- **One JSON per page.** Each page is a complete Polotno page object, saved, validated, priced and replaced on its own. The editor loads `{ ...deck, pages: deck.custom.particl.order.map(id => deck_pages[id]) }`.

```jsonc
// treatments.deck — the envelope (no pages inside)
{
  "schemaVersion": 4,
  "width": 1920, "height": 1080, "unit": "px", "dpi": 72,
  "fonts": [{ "fontFamily": "Brand Sans", "url": "/api/fonts/<id>" }],   // self-hosted, same origin
  "custom": { "particl": { "v": 1, "order": ["pg_a1", "pg_b2"], "theme": { /* set by the cover */ } } }
}

// treatments.deck_pages — { [pageId]: page }
{
  "pg_a1": {
    "id": "pg_a1",
    "background": "#101014",
    "custom": { "particl": {
      "v": 1,
      "type": "cover",              // cover | index | heading | sub-heading | content | mood-board | motion
      "section": "cover",           // the section library key
      "rev": 3,                     // bumped on every save of this page
      "says": "…", "looks": "…",    // "What it says" / "How it looks"
      "job": null                   // the quoted job that last made this page (its words and its pictures)
    } },
    "children": [
      { "type": "text",  "id": "pg_a1.title", "x": 120, "y": 96, "width": 1680, "fontSize": 96,
        "fontFamily": "Brand Sans", "text": "…", "custom": { "slot": "title" } },
      { "type": "image", "id": "pg_a1.hero", "x": 120, "y": 280, "width": 960, "height": 540,
        "src": "/api/media/<generationId>?stream=1",
        "custom": { "slot": "hero", "media": { "kind": "generation", "id": "<generationId>" } } }
    ]
  }
}
```

Rules this format needs, each from something seen in the spike:
1. Element ids are `<pageId>.<slot>` (or `<pageId>.<random>`). Polotno accepts duplicate ids across pages.
2. `src` is a same-origin route built from `custom.media`, never a signed URL. The server rebuilds `src` from `custom.media` on load, so a stale or edited `src` cannot point anywhere else.
3. Every write is checked with `validateDesign(..., { mode: 'canonical' })` and kept under a size cap. `canonical` rejects unknown keys, so our data stays in `custom`.
4. Mood-board frames take the picture's exact ratio (no rounding) and full crop, so exports embed the original bytes.
5. Fonts are self-hosted (`fonts[].url` on our origin; `setGoogleFonts([])`).
6. `schemaVersion` is stored. Polotno says the format is pre-1.0 and changes will be additive. The `@polotno/schema` README (0.9.0) says `normalizeDesign` and `parseDesign` "migrate an older document up to the current version before validating", and that a missing `schemaVersion` means 0. This spike did not test migration. (Polotno's docs page says the opposite: "It does **not** migrate old `schemaVersion` documents". The package README is newer and specific.) Keep storing `schemaVersion` either way.

**How pages are written** (a proposal, not tested in the spike). The per-workspace database is SQLite (libSQL), which has `json_set` and `json_extract`.
- **Page ids are restricted** to `pg_` plus 8 to 32 characters from `[A-Za-z0-9_]`, checked on the server. A page id becomes a JSON path key (`$."pg_a1"`), so it must never contain `.`, `"`, `[` or `$`. Pages the editor creates must be given our id (`store.addPage({ id })` keeps a given id, seen in the spike); Polotno's own ids include `-`.
- **Update one page in place, with compare-and-swap on `rev`**:
  `UPDATE treatments SET deck_pages = json_set(deck_pages, '$."<id>"', json(:page)), updated_at = :now WHERE project_id = :p AND json_extract(deck_pages, '$."<id>".custom.particl.rev') = :expectedRev`
  The new page carries `rev = expectedRev + 1`. If zero rows change, someone else saved first. The client reloads that page and the person sees the conflict; nothing is overwritten. Other pages are not touched.
- **Add, delete and reorder** change `deck.custom.particl.order` and `deck_pages` together, in one statement or one transaction, so the order never names a missing page and no page is left out of the order.
- **Alternative:** one row per page (owner question 6). It makes compare-and-swap a plain column check, but adds a table, which the "content stays in treatments and treatment_versions" decision does not allow as written.

**Jobs and re-runs** (owner Q24: "Deck page: one quoted job per page covering its words and its pictures").
- `custom.particl.job` is the id of the one quoted job that last produced the page, both its words and its pictures.
- **A re-run is a new quoted job.** When it succeeds, the page is replaced through the compare-and-swap above, with `rev + 1` and `job` set to the new job. Before replacing, the server saves a `treatment_versions` snapshot, so the earlier page can be compared and restored (editing standard: per-page versions).
- **One open job per page.** The server refuses to quote or start a second job for a page while one is open for it (quoted, approved or running), checked on project id plus page id. A double tap cannot pay twice for the same page.
- A person's own edits (moving, retyping) cost nothing, bump `rev`, and leave `job` as it was.

## 11. Not covered here (left for spike (b) on 29 Oct)

Against `docs/plans/deck-editor.md` Part 3: 50 undo steps that survive a reload; a 3008×1692 at 2× screenshot of the editor itself (only a server render at that size was made); PPTX opened in PowerPoint and LibreOffice (only its XML was inspected); MP4 and GIF export; Liveblocks, comments and per-element versions; removing the template and stock panels; a written licence quote; the editor with the real key on a registered host.

## 12. Open questions for the owner

1. **Where may the trial key run?** The terms say development and staging only. Is there a non-public staging host to register, or should the trial stay on localhost? Using it on particl.si (even house-only) risks the account being disabled.
2. **Trial length:** Polotno's pages say both 30 and 60 days. Will you ask Polotno which applies to the key created on 19 Oct?
3. **Server renders:** add `headless` to the key's domains, or keep a separate key for server rendering (a second variable, for example `POLOTNO_SERVER_KEY`)?
4. **Fonts:** agree that Google Fonts stay off and brand and Hindi fonts are self-hosted (needed for our CSP)?
5. **Licence questions for Polotno** (in writing): a hosted multi-tenant product as "one Application"; the "competing editor or design platform" clause; whether staging and `headless` count as extra domains; whether the package licence's "evaluation ... not production use, wherever they run" lets the trial key run on a production host for internal evaluation, or the trial page's URL rule applies; whether `@polotno/schema` is free in production (its package licence) or needs a subscription (its docs page).
6. **Format:** accept the two-column proposal in section 10 (`deck`, `deck_pages` on both tables)? Or should per-page versions get their own rows, which a strict "content stays in treatments and treatment_versions" would not allow?
