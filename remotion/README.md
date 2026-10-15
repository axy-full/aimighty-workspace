# Export templates (Remotion)

Particl's own templates for exports: captions on a cut, title and end cards, 16:9 and 9:16 versions, 6/15/30 s cutdowns and the final MP4. Plan: `docs/plans/remotion.md`.

- **Only our templates are rendered.** A request names one composition and passes plain props; nobody uploads a project or code.
- **Self-hosted only.** Rendering runs on our own worker (no Remotion Lambda, no AWS). Free License, confirmed in writing 13 Oct 2026; at 4 people the Company License must be bought first. **No licence key and no events are sent to Remotion** (owner decision, 14 Oct 2026): server-side with no key the renderer sends nothing. Pinned to 4.x. Upgrading to Remotion 5.x needs the owner's approval first (NEEDS AKSHAY): 5.0 may require a licence key.
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
spec.json  { "version": 1, "composition": "final", "props": {...}, "output": { "video": true, "format": "h264", "stills": [0, 45], "subtitles": ["srt", "vtt"], "conform": "auto" } }
input/     the files the props name
output/    export.mp4 (or export.mov for ProRes), still-<frame>.png, subtitles.srt / subtitles.vtt, result.json
```

`output.format` is `h264` (the default: `export.mp4`, CRF 20, AAC), `prores-422` or `prores-422-hq` (`export.mov`, 10-bit 4:2:2 with 16-bit PCM sound; at most 1800 frames: 60 s at 30 fps, 30 s at 60 fps; a constant, not a setting). H.265 is refused ("H.265 is not available."): owner, 15 Oct 2026, until his lawyer answers. A ProRes 30 s 1080p file is about 485 MB (422) or 716 MB (422 HQ); `result.json` names each file with its `format` and `mime`.

`output.subtitles` (`srt` and/or `vtt`) writes sidecar subtitle files from the same cues the captions are burned in from, on the finished video's own clock (a trim moves them, a cut-away caption is not in the file, a cutdown's source-time cues land in the cut). It is plain text: with `output.video: false` and no stills it needs no input file and no renderer. An export with no caption text refuses it (`spec.output.subtitles: the export has no caption text (no cues) to write`). `result.json` lists each file with kind `subtitle`, its format and mime (`application/x-subrip`, `text/vtt`).

`output.conform` is `auto` (the default) or `off`. Every picture input is probed for its frame rate; with `auto`, a **variable-frame-rate** file (its nominal and average rates differ by more than 2%, as phone clips and screen recordings often do) is re-encoded once, before the render, to a **constant rate equal to the export's own** (x264 CRF 14, sound re-encoded as AAC, length unchanged) with the bundled ffmpeg, and the render reads that copy; the original in `input/` is never changed. A file already at a constant rate is never touched, even at another rate (the render resamples it by time, as before); it is only reported. `result.json` has `inputs`: one line per picture with `fps`, `variableFrameRate`, `targetFps`, `conformed`, `resampled` and, if the pre-pass failed and the render read the original, `conformFailed`.

Exit codes: 0 done, 2 spec invalid or too long, 3 an input is missing or is not what the spec says it is (ffprobe reads every clip and music file: a different length by more than 0.1 s, a different size, or sound the request says is there but is not, is refused), 4 the render failed (`output/result.json` says why). Tuning comes only from the worker's environment: `REMOTION_RUNTIME_DIR` (where Remotion's Chrome download lives; the command moves there after reading its session paths, because Remotion looks for Chrome under the working directory's nearest package.json), `REMOTION_CONCURRENCY` (default 2), `REMOTION_MAX_SECONDS` (default 120, cannot be raised above it), `REMOTION_BROWSER_EXECUTABLE`, `REMOTION_BUNDLE_DIR`. No licence key is passed, ever (owner decision, 14 Oct 2026): with none, the renderer sends nothing to Remotion. A test fails if one appears.

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
