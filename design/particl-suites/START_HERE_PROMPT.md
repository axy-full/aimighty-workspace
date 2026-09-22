# Claude Code — install + build prompt (type at the `>` prompt, first message of a fresh session)

I am the user, typing at the prompt. This is the brief.

The folder `~/Downloads/particl-glass-handoff/` contains the design handoff. First copy it into the repo: `mkdir -p design/particl-suites && cp -R ~/Downloads/particl-glass-handoff/* design/particl-suites/` and commit that as `docs: particl glass handoff`.

Then read, in this order: `design/particl-suites/GLASS_SPEC.md` (visual layer + mobile Home — wins every disagreement), `FINAL_SPEC.md` (IA, Higgsfield contracts, order of work — unchanged except its §6), `README.md` (screen-by-screen detail). Open `design/particl-suites/Particl macOS 27.dc.html` and `Particl Mobile iOS 27.dc.html` in a browser beside the app; they are click-through references, not code to copy.

Do not rebuild what exists: the Graphite shell (`components/graphite/*`, `lib/shell/*`, `app/graphite.css`), the enhancer route, Crew, the Higgsfield consumer layer. Extend them.

Work in this order, one branch each, each ending with typecheck + lint clean, the acceptance checks passed, and a PR description listing files changed and how you verified against the prototype:

1. `feat/glass-desktop` — GLASS_SPEC §1–2: add `app/glass.css` (`--gl-*` over `--gx-*`, `@supports not (backdrop-filter)` fallback); wallpaper on the shell root; Header, StageStrip, Library, stage `<main>`, Inspector as floating islands with 10px gutters; capsule every control/chip/segment/badge/menu row; boxes (thumbnails, wells, nodes, cards, lanes) stay 12–16px; glass the ⌘K palette, model sheet, context menu, narrow overlays, Rig nodes and port cores. No logic changes.
2. `feat/glass-mobile-home` — GLASS_SPEC §3: floating glass tab bar (Home · Gen · Suites · Assets · More), glass top bar with context badge, glass sheets, Home = "Where to?" + six suite tiles with live facts + one Assets row and nothing else; Studio tile opens the stage grid with a Home back; 110px bottom padding on scroll regions; tap targets ≥ 44px.
3. Then FINAL_SPEC §1 steps 1–5 in order (assets everywhere; Business = Marketing Studio; Viral = Genjutsu; Gen from the live catalogue with per-second length and the `enhance_prompt` passthrough; Atomik skills + Workspace tabs), each on its own branch as already described there.

Rules: one composer, one credit balance, assets on every page, every card routes somewhere real; nothing paid runs without a live quote the user saw; failed renders never billed; blocked buttons show the reason inline; match the prototypes' copy verbatim; keep every `--gx-*` token — the glass layer overrides only background, border, box-shadow, border-radius and backdrop-filter. Ask me only when GLASS_SPEC/FINAL_SPEC and a prototype genuinely disagree.

Start now: do the copy + commit, read the files, then reply with the list of files you will create or change for branch 1 — nothing else — and wait for my go.
