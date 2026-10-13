# Export templates (Remotion)

Particl's own templates for exports: captions on a cut, title and end cards, 16:9 and 9:16 versions, 6/15/30 s cutdowns and the final MP4. Plan: `docs/plans/remotion.md`.

- **Only our templates are rendered.** A request names one composition and passes plain props; nobody uploads a project or code.
- **Self-hosted only.** Rendering runs on our own worker (no Remotion Lambda, no AWS). Free License, confirmed in writing 13 Oct 2026; at 4 people the Company License must be bought first.
- **Nothing is fetched.** The typeface is bundled in `public/fonts` (SIL OFL); media and logos are files in the session's `input/`, named by plain relative paths. A unit test fails if browser or command code mentions a URL, `fetch`, a socket or a stylesheet import.
- **Free to customers**, 0 cr. Paid engine steps inside an export bill through their own paths; nothing here knows about prices.
- **Own package.** `remotion/` has its own `package.json` and lockfile with pinned versions, so the app's install and build do not carry Remotion, webpack or a browser. The worker image installs it.

## Compositions

| id | what | props |
|---|---|---|
| `title-card` | title, subtitle, accent bar, optional logo | `card` |
| `end-card` | headline, call-to-action pill, line, optional logo | `card` |
| `captions` | one clip with burned-in captions (`bold`, `clean`, `karaoke`) | `clip`, `captionStyle` |
| `reframe` | one clip as 16:9 or 9:16: `fill` (crop on a focus point) or `fit` (whole picture, blurred backdrop) | `clip` |
| `cutdown` | 6, 15 or 30 s from one source: marked moments or an even spread; frame-exact | `source`, `targetSeconds`, `keep`, `cues` |
| `final` | title, clips (trimmed, reframed, captioned), end card, music | `title`, `clips`, `end`, `music` |
| `fixture-clip` | our own sample picture, for tests and timing | `durationSeconds`, `label` |

All take `aspect` (`16:9` or `9:16`), `fps` (24, 25, 30, 60; default 30) and `scale` (0.1 to 1; default 1 = 1920x1080 or 1080x1920; smaller is for previews and tests). Props are checked by `src/lib/validate.ts`: unknown keys, URLs, absolute paths, `..`, over-long text, too many clips or cues are refused. A source needs its `durationSeconds`, `width` and `height` (the app knows them); a declared length longer than the file would fail a render, so the worker's export command can probe and correct it.

## The export command (what the worker runs)

`node build/cli.mjs`, working directory = the session folder. No arguments.

```
spec.json  { "version": 1, "composition": "final", "props": {...}, "output": { "video": true, "stills": [0, 45] } }
input/     the files the props name
output/    export.mp4, still-<frame>.png, result.json
```

Exit codes: 0 done, 2 spec invalid or too long, 3 an input is missing, 4 the render failed (`output/result.json` says why). Tuning comes only from the worker's environment: `REMOTION_CONCURRENCY` (default 2), `REMOTION_MAX_SECONDS` (default 120, cannot be raised above it), `REMOTION_BROWSER_EXECUTABLE`, `REMOTION_BUNDLE_DIR`. No `licenseKey` is passed: the Free License needs none, and "free-license" makes Remotion call remotion.pro, which the worker must not reach.

## Layout and commands

- `src/lib/` plain TypeScript, no Remotion or React: props, validation, frame maths, captions, cutdown, reframe, timeline. Unit tests: `tests/unit/remotion*.spec.ts`.
- `src/*.tsx` the compositions; each renders a timeline from `src/lib/timeline.ts`.
- `node/` the export command (`export.ts`, `cli.ts`, `renderer.ts`) and the build (`bundle.mjs`).

```sh
cd remotion && npm ci && npm run typecheck && npm run bundle    # build/bundle and build/cli.mjs
# Real renders, a few small frames and clips on CPU (about 100 s):
~/ops/heavy.sh nice -n 10 node --test --test-concurrency=1 remotion/test/render.test.mjs
```

The first real render downloads Remotion's pinned Chrome Headless Shell into `node_modules/.remotion` (about 90 MB, from remotion.media). The worker image does that at build time instead (PR 2).
