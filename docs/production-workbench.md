# Particl production workbench

The September 13 redesign is integrated selectively over current main. The source archive’s application baseline was not substituted for the newer backend. The original Particl logo, neutral palette, desktop stages/canvas/inspector and mobile bottom navigation are retained. `/` redirects to `/workbench`; existing production, settings and review routes remain available.

## Connected workflow

A signed-in user can create or open a production in a private working space, write a brief/script, break it into editable nodes, bind character/world/moodboard references, generate a priced take, inspect recovered versions, save deterministic image operations, assemble a sequence and download an EDL/source package. Node bindings and exported manifests retain reference and take lineage. The sample campaign is editable reference material; signed-out visitors must sign in to save, upload or run paid jobs.

`workbench_projects` stores owner-scoped snapshots with compare-and-swap revisions. `workbench_shots` maps each owner/draft/node to an existing production shot. Real production IDs are server-owned and cannot be swapped through an update. `workbench_bibles` stores immutable published context versions; collaborators create their own drafts from shared context. Database clients and media access run within the established tenant context.

`/api/workbench/engines` exposes only configured media models and credit estimates. Generate binds references to existing upload/generation records, disables implicit prompt refinement, maps to a real shot, and submits `/api/generate`. Jobs run using the existing provider adapters, Inngest/inline execution, storage and meter. Activity independently recovers media jobs and Atomik plans, including older active jobs; completion does not overwrite a newer manual selection.

Genie and the director, DOP, editor, production designer, costume stylist, producer and continuity supervisor run one selected task at a time. `/api/workbench/atomik` saves an addressable job, quotes a bounded output budget, reserves spend and runs asynchronously. Auto selects an economical priced language model from the configured Gateway catalogue. Users explicitly confirm the quoted run and can edit applied plan nodes individually.

Paid media and Atomik submissions persist retry identities before submission and reuse exact payloads after an interrupted response. Server claims are durable and tenant/user scoped. Shared atomic reservations include outstanding work in credit, concurrency, project and token limits. Delayed worker delivery cannot repeat an inline paid call. An ambiguous provider result is never automatically resubmitted. Video submission claims cover transport failures and delayed releases; known handles recover after lost database acknowledgments, while uncertain outcomes retain their estimated spend. A complete database outage before a returned handle can be saved requires support to reconcile that task ID.

Image tiles use authenticated, cached 640-pixel WebP previews with original-image fallback; video tiles reuse the existing bounded poster capture/cache. Uploads use the existing bounded chunk client and server-side streaming assembly. Saved image transforms create new uploads and preserve their source lineage. The legacy workbench upload endpoint delegates to the existing authenticated upload handler.

## Export and context limits

- Atomik reads project text and selected reference metadata/URLs, plus supported uploaded plain text up to 100 KB per file. It does not inspect image/video/audio/PDF content or fetch arbitrary websites. URL references remain saved links; media generation requires an uploaded or already generated asset.
- Image crop, grade, transform, mask and mix operations are deterministic. They do not encode edited video or a finished movie.
- EDL supports one video track, straight cuts, integer 24/25/30 fps and zero-based source timecode. Scratch audio travels separately. Source frame rates and embedded timecodes are not probed. Validate relinking in the target editor before delivery.
- Source ZIPs include actual source bytes and recursive reference lineage, with a 200 MB browser limit. Larger deliveries require the EDL and separately collected sources. There is no rendered master, synchronized sound mix, transition or fractional/drop-frame support.
- Conflicting edits from another window stop autosave rather than silently overwrite. An unresolved paid submission remains recoverable and does not start a replacement job automatically.
- Production provider execution is connected but release verification uses mocks only; no paid provider call is authorized by the release test plan.

## Verification

Run `npm run lint`, `npx tsc --noEmit`, `npm run test:unit` and `npm run build`. Run the dedicated workbench suite with a local `ENGINE_MOCK=1` development server and `PW_BASE_URL=http://localhost:4551 PW_CHANNEL=chrome npx playwright test --config=playwright.workbench.config.ts`. It exercises real local authentication and mocked jobs at 360×640, 390×844, 844×390, 1440×900 and 1920×1080. The mock-server guard prevents this workflow suite from calling a production provider.

Unit coverage includes tenant/owner isolation, concurrent snapshot updates, stable shot mapping, immutable bible publication, media sharing, duplicate paid submits, spend reservation races, delayed worker fallback, stale Atomik recovery, context boundaries, job recovery and exact-frame EDL/source packaging. Deployment uses the existing `particlstudio` Vercel project and preserves remote environment settings.
