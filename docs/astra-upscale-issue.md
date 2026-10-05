# Astra video upscale: always quoted at the 4K tier; a 1080p target cannot be chosen

Drafted as a GitHub issue. Issues are disabled on axy-full/aimighty-workspace, and enabling them is a repo setting, so this is saved here instead. Not fixed in D0. Read from the code on `main` (a381ee67); no paid render was run.

## Short version
- **Quote and reservation are always at the 4K tier.** A 5 s clip at 30 fps is quoted and reserved at **38 cr** ($2.50 engine cost); at 60 fps, **75 cr** ($5.00).
- **The final charge follows the measured output, not the quote.** If the delivered clip's short side is ≤1080, settlement recomputes at the 1080p rate: 5 s at 30 fps settles at **23 cr** (`engine_cost_usd` 1.50, `billed_credits` 23). So a 1080p output is *not* charged the 4K price.
- **Nobody can ask for 1080p.** There is no target control, admission rewrites any other resolution to `4k`, and dispatch refuses anything but `4k`. The rate card's "Topaz upscale, 5s 1080p · 23 cr" row is never offered as a quote; it is only reachable as a settled charge.

## Where
- Model offers only 4K: `lib/models.ts:309` (`resolutions: ["4k"]`).
- Admission coerces the resolution: `lib/generationAdmission.ts:847-849`; notice "This quote uses the 4K tier…" at `:785`; estimate at `:2016-2021`.
- Callers send `resolution: "4k"`: `components/make/AstraUpscale.tsx:103-111`, `lib/shell/next-actions.ts:317`.
- Dispatch requires 4K: `lib/submitVideo.ts:257`.
- Rates: `lib/vendorRates.ts:132-143` ($0.30/s 1080p, $0.50/s 4K); 60 fps doubles (`lib/vendorPricing.ts:31-41`).
- Settlement from the measured output: `lib/falVideo.ts:300-306` (short side ≤1080 → 1080p tier, else 4K; fps > 30 → doubled), then `lib/generationSettlement.ts` → `lib/meter.ts:129-141`.
- What fal is asked for: an `upscale_factor` aimed at a 2160 short side, capped at 4× (`lib/astra.ts:44-54`). No target resolution is sent.

## What follows from that
| Source short side | Factor | Output short side | Settles at |
|---|---|---|---|
| 1080 | 2 | 2160 | 4K |
| 720 | 3 | 2160 | 4K |
| 540 | 4 | 2160 | 4K |
| 480 | 4 | 1920 | 4K |
| 360 | 4 | 1440 | 4K |
| ≤270 | 4 (cap) | ≤1080 | 1080p |

A 1080p-tier charge only happens for very small sources, or if Astra overrides the requested factor.

## Open questions
1. **Should a 1080p target exist?** The rate card and the Graphite design both show "23 cr at 5 s 1080p · 38 cr at 4K" as a choice. Today it is not a choice.
2. **Over-budget outputs stall.** If the measured output costs more than the quote (for example slightly longer at 4K), `collectFalVideo` throws "exceeds the reviewed budget"; the take stays running with its reservation and is never settled automatically (`lib/falVideo.ts:304-306`).
3. **Recorded cost is our estimate.** `engine_cost_usd` is the rate table × measured seconds, not a figure from fal. `docs/astra-video-upscale.md:13` says no real paid Astra render has been rehearsed, so whether fal's invoice matches the 1080p/4K boundary used here is unverified.
4. **Reservation size.** A workspace with 23–37 cr cannot start a 5 s upscale that would settle at 23 cr, because 38 cr is reserved first.

## Tests that pin today's behaviour
`tests/unit/generationAdmission.spec.ts:712-768`, `tests/unit/astra.spec.ts`, `tests/unit/submitVideo.spec.ts:204-222`, `tests/astra-gen.spec.ts`, `tests/unit/nextActionsPriced.spec.ts:130-134`. No test pins the 5 s 23 / 38 cr figures against a real 1080p output.
