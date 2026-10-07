# Design brief: Ads · image ad with versions and presets (for Claude Design)

Release 1 list B item "image-ad variants and presets". The handoff (`design/particl-graphite/`) has only frame A2 "Ads · hooks, formats, ads" (`?view=board&kind=ads&frame=2`): one image-ad card with one Make button at 3 cr. There is no version control, version batch price or preset picker anywhere in the handoff. The logic already exists in code (`lib/shell/image-ads.ts`: builds, presets, quality rules, at most 2 product stills per preset); only the screen is missing.

**Where:** Ads board frame 2, the image-ad card at 1440×900 and its Inspector; a 390×844 phone treatment (or the existing "Open this on a larger screen" page if the phone board has no image-ad card).

**Version row:** a quiet row under the card's prompt: the card's builds (the code's own names) and a quality choice, plus a count stepper for several versions at once (proposed 1–4).
- States: one version (default); several versions; quality unavailable for the chosen preset or build (the choice disabled, with the code's one-line reason).

**Button price:** "Make N versions · X cr", X being the batch total from the server; one version keeps "Make · 3 cr". Also draw: price loading, estimate failed.

**Preset picker:** opens from a "Preset" row on the card or Inspector. Searchable catalogue on shelves; each preset a tile with its name and a small still.
- States: selected (with a clear link); no search results; catalogue unavailable.
- A chosen preset uses up to 2 product stills: show "2 of 2 stills" and the over-limit line.

**Other states:** the sample workspace (row visible, no price, no Make button, the board's one sample line); held, queued, rendering; results landing as one card per version.

**Rules:** phone targets ≥ 44 px; text ≥ 12 px and ≥ 55% white; the name is "Product image", never "Marketing Studio"; no invented preset or build names beyond what the server and the build catalogue return.
