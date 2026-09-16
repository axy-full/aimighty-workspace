# Script and idea development

Studio → Script & breakdown offers Screenplay and Ad-film script modes. Both accept PDF, TXT and Fountain sources; the original file remains a workspace asset. Existing local PDF extraction, English OCR review, scene selection and manual beat notes remain available. Script format is saved with the project and its published shared context.

Studio → Brief & ideas and Script & breakdown use the same saved development workflow. Users choose a connected Claude or OpenAI model (shown as ChatGPT), a supported reasoning effort and optional creative instructions. Model eligibility and prices come from the existing live catalogue. A complete quote is required before a paid run.

## Execution and source coverage

Each source section has three separately persisted phases: draft, critique and refinement. The critique sees the original source and saved draft; refinement sees both prior outputs. Provider calls use the installed AI SDK through AI Gateway, with automatic provider-call retries disabled. There is no paid repair call for invalid model output.

Screenplays retain the existing one-million-character source limit. Source segments cover the entire script, including any preamble; long scenes can span several sections. Returned scene IDs and source offsets must exactly match their assigned segments. Offsets are JavaScript string indices, matching the stored source and canvas extraction. Idea results contain distinct treatments, a recommendation, visual direction and review notes. Script results contain beats, proposed shots, cast, props, locations, sound and production requirements.

Inngest runs persisted phases independently. If queue dispatch is unavailable, a bounded after-response continuation and authenticated resume requests advance unstarted phases. A started phase with an unknown outcome is never automatically resubmitted. Completed results are paginated by source section; the complete JSON export assembles those pages in the browser so long results do not exceed API response limits.

## Review and application

Results do not overwrite the source. Users explicitly add selected ideas to creative direction or reviewed scene nodes to the canvas. The browser verifies the saved source fingerprint immediately before applying a result and checks it again before changing the project. Changed source or creative context requires a fresh run. Applied results retain source ranges and job provenance, and duplicate application is prevented. Canvas capacity and text limits reject an oversized insertion without truncating the source.

## Spend and recovery

The quote covers every phase, reasoning limit and prior-result context. Admission checks the current source hash and quoted ceiling, saves an immutable request/source snapshot and reserves spend through the existing workspace/project ledger. Funding-source checks protect each subsequent phase. Request identities and browser write-ahead records protect lost-response recovery. Terminal billing settlement is retried from saved state without repeating provider work. Interrupted admission and uncertain provider calls are distinct states; operations must reconcile uncertainty rather than rerun it.

The new tenant tables are `workbench_development_jobs` and `workbench_development_steps`. Full database backup captures both. Recovery drain/report and backup preflight include development jobs alongside the existing Atomik and generation workers.

## Collective assets and originals

The top-level Assets entry opens the complete authorized workspace library, grouped by Images, Videos, Audio, Documents and Other files. It uses the same uploads and generated takes as Gen, with pagination, reference reuse and existing edit/upscale actions. Legacy Elements, References and Unfiled views remain available.

Node inspector and context menus offer Download original separately from rendered PNG export. Authenticated media routes stream full stored source files with attachment filenames. Uploaded files remain byte-identical. Older non-Topaz generated stills may already have been normalized to full-resolution PNG at intake; this change does not recreate discarded vendor metadata or encoding. Rendering a canvas preview does not change the original download.

## Verification scope

Tests cover source coverage, source changes, quotation/admission, concurrency, loss of HTTP responses, funding changes, interrupted provider phases, settlement recovery, result pagination, explicit application and file download identity. Browser workflows run against isolated mock workspaces. SDK transport tests exercise the installed Gateway protocol without paid provider calls. Real Claude/OpenAI generation quality and availability still depend on the workspace's configured provider and selected model; this release does not perform an unapproved paid generation rehearsal.
