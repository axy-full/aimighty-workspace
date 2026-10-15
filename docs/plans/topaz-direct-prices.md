# Topaz direct: price table (T0, before building)

**Draft, 16 Oct 2026. Docs only: no code, no call, no key used.** Owner, 15 Oct 2026, 14:05 IST: "Topaz goes DIRECT", with the price table and data terms written before any adapter ("T0", `docs/plans/provider-adapters.md` section 8). This is that table.

**Every Topaz figure below is as published 16 Oct 2026, check before relying.** They were read from Topaz's own pages on 16 Oct 2026 and not re-checked here:
- https://www.topazlabs.com/api (plans, credit value, image tiers)
- https://developer.topazlabs.com/getting-started/model-pricing.md (family table)
- https://developer.topazlabs.com/getting-started/individual-model-pricing.md (per-model page)
- https://developer.topazlabs.com/video-models/astra-2.md (Astra 2 frames per credit)

Our own current rates are from `lib/vendorRates.ts` on `release/1` (fal's `fal-ai/topaz/upscale/image` and `topaz/upscale/video/creative`) and our presets from `lib/topaz.ts`. **Customer credit prices are not computed here.** The customer price moves with the engine cost through the same price path (`billCredits`, the rate card), and nothing is priced below cost; the margin policy is private to the owner. Any change to what customers see changes CLAUDE.md § Pricing too and needs the owner's yes.

## 1. What a Topaz credit costs (published)

| Plan | Monthly fee | Credits | Per credit |
|---|---|---|---|
| Starter | "coming soon" | | $0.12 |
| Developer | $50 | 500 | **$0.10** |
| Scale | $240 | 3,000 | **$0.08** |
| Enterprise | on request | volume | not published |

Both columns below use $0.10 (Developer) and $0.08 (Scale). The monthly fee is a commitment: the per-credit figure holds only if the pack is used. Overage pricing and whether unused credits roll over were not read.

## 2. Images

**Published, and it contradicts itself** (flagged in section 5):
- The API page: "Up to 24 MP output: 1 credit", "32 MP: 2", "48 MP: 3" (under a heading "1 API credit = 32MP").
- The developer docs' family table: linear by output megapixel. Gigapixel **24 MP per credit**; Wonder 4; Bloom 2; Sharpen GAN 24; Sharpen Generative 20; Denoise 24.

**Our rate on fal today:** $0.08 up to 24 MP, $0.16 up to 48 MP (`fal-ai/topaz/upscale/image`).

Our five presets (`lib/topaz.ts`): Standard V2, High Fidelity V2, Low Resolution V2, CGI, Text Refine. They are Gigapixel-style model names; **I took each as the Gigapixel family (24 MP per credit), because the per-model page was not usable per preset** (section 5). Confirm the mapping before building.

Reading A is the docs' linear rule (24 MP = 1 credit, 48 MP = 2). Reading B is the API page's tiers (48 MP = 3).

| Preset | Output | fal (today) | Direct, Developer $0.10: A / B | Direct, Scale $0.08: A / B | Dearer than fal? |
|---|---|---|---|---|---|
| Standard V2 | 24 MP | $0.08 | $0.10 (1 cr) / $0.10 (1 cr) | $0.08 / $0.08 | Developer: direct, by $0.02 (25%). Scale: equal |
| Standard V2 | 48 MP | $0.16 | $0.20 (2 cr) / $0.30 (3 cr) | $0.16 / $0.24 | Developer: direct, by $0.04 (A, 25%) or $0.14 (B, 88%). Scale: equal (A) or direct by $0.08 (B, 50%) |
| High Fidelity V2 | 24 MP | $0.08 | as Standard V2 | as Standard V2 | as Standard V2 |
| High Fidelity V2 | 48 MP | $0.16 | as above | as above | as above |
| Low Resolution V2 | 24 / 48 MP | $0.08 / $0.16 | as above | as above | as above |
| CGI | 24 / 48 MP | $0.08 / $0.16 | as above | as above | as above |
| Text Refine | 24 / 48 MP | $0.08 / $0.16 | as above | as above | as above |

**Other image families in Topaz's table (not offered by us today), at A, per output size:**

| Family | MP per credit | 24 MP | 48 MP |
|---|---|---|---|
| Wonder | 4 | 6 cr = $0.60 / $0.48 | 12 cr = $1.20 / $0.96 |
| Bloom | 2 | 12 cr = $1.20 / $0.96 | 24 cr = $2.40 / $1.92 |
| Sharpen (GAN) | 24 | 1 cr | 2 cr |
| Sharpen (Generative) | 20 | 1.2 cr = $0.12 / $0.096 | 2.4 cr = $0.24 / $0.192 |
| Denoise | 24 | 1 cr | 2 cr |

(Dollars are Developer / Scale. Whether fractions are billed as fractions or rounded up was not read.) The per-model page lacks Text & Shapes, Redefine, Recover 3 and Wonder, so those were read only from the family table.

## 3. Video

**Published.** The family table gives credits **per 10 s of 1080p at 30 fps** (300 frames): Proteus 4; Starlight Fast 6; Starlight Quality 12; Astra 40. The Astra 2 page gives **frames per credit**: 1080p 10, 4K 6. Billing is by output frame, so it scales with frame rate (stated on the Astra 2 page; assumed the same for the others). **No 720p figure was found. Iris and Rhea were not read.**

**Our rate on fal today (Astra 2, `topaz/upscale/video/creative`):** $0.30 a second up to 1080p, $0.50 a second at 4K, doubled at 60 fps (`docs/astra-video-upscale.md`; plan section 8). It is flat below 1080p, so 720p costs $0.30 on fal.

### Astra 2, by the frames-per-credit page (the current Astra 2 page; reading X)
1080p at 30 fps is 3 credits a second; 4K at 30 fps is 5; 60 fps doubles both.

| Output | fps | Credits a second | Direct, Developer $0.10 | Direct, Scale $0.08 | fal | Dearer? |
|---|---|---|---|---|---|---|
| 720p | 30 / 60 | not found | not found | not found | $0.30 / $0.60 a second | unknown |
| 1080p | 30 | 3 | $0.30 a second | $0.24 a second | $0.30 | Developer: equal. Scale: **direct cheaper by $0.06 (20%)** |
| 1080p | 60 | 6 | $0.60 | $0.48 | $0.60 | Developer: equal. Scale: direct cheaper by $0.12 |
| 4K | 30 | 5 | $0.50 | $0.40 | $0.50 | Developer: equal. Scale: direct cheaper by $0.10 |
| 4K | 60 | 10 | $1.00 | $0.80 | $1.00 | Developer: equal. Scale: direct cheaper by $0.20 |

A 5 s clip, reading X: 1080p30 is 15 credits ($1.50 Developer, $1.20 Scale) against fal $1.50; 4K30 is 25 credits ($2.50, $2.00) against fal $2.50.

### Astra, by the family table (reading Y: 40 credits per 10 s at 1080p30, so 4 credits a second)
| Output | fps | Credits a second | Direct, Developer | Direct, Scale | fal | Dearer? |
|---|---|---|---|---|---|---|
| 1080p | 30 | 4 | $0.40 | $0.32 | $0.30 | **Direct dearer**: Developer by $0.10 (33%), Scale by $0.02 (7%) |
| 1080p | 60 | 8 | $0.80 | $0.64 | $0.60 | Direct dearer by $0.20 (33%) / $0.04 (7%) |
| 4K | 30 / 60 | not in the family table | not found | not found | $0.50 / $1.00 | unknown |

Readings X and Y are both published and differ (section 5). X says direct at Developer equals fal and Scale is cheaper; Y says direct is dearer. The 14 Oct plan used a third figure (about 7.7 frames a credit at 1080p, 4.3 at 4K), which X supersedes.

### Other video families (not in our code; per second at 1080p30, reading from the family table)
| Model | Credits a second | Developer | Scale | fal comparison |
|---|---|---|---|---|
| Proteus | 0.4 | $0.04 | $0.032 | plan section 8 recorded $0.02 a second on fal, not in our code: direct is dearer ($0.02 or $0.012 a second) |
| Starlight Fast | 0.6 | $0.06 | $0.048 | no fal rate in our code |
| Starlight Quality | 1.2 | $0.12 | $0.096 | no fal rate in our code |

Double at 60 fps. 720p and 4K figures for these were not found.

## 4. Data terms (read 16 Oct 2026; not found means not found)
- **Training:** no statement about training on our inputs or outputs was found.
- **Retention:** video is **deleted automatically after 7 days** unless a shorter TTL is set. A `DELETE /video/{requestId}/media` endpoint exists. Image delete endpoints were not read. Retention for images and logs was not found.
- **Terms page:** returned 404.
- **Our rule** (owner, 14 Oct, and plan section 8): delete the vendor's copy once we have stored the output. Under the owner's 15 Oct 22:15 data terms there is no no-training gate on wiring: Particl does not train, providers may under their own policies. The data table is `docs/legal/where-your-data-goes.md` on #761; the optional request to Topaz is `docs/legal/vendor-requests.md` section 5. ⚖ A lawyer should read Topaz's terms once the page exists.

## 5. Contradictions and gaps in Topaz's own pages
1. **Image tiers.** The API page says 24 MP = 1 credit, 32 MP = 2, 48 MP = 3, under the heading "1 API credit = 32MP"; the developer docs say linear by output MP (Gigapixel 24 MP a credit). Three readings: 48 MP costs 2 credits (linear), 2 (heading, 32 MP a credit, rounded up) or 3 (the tiers). Section 2 shows A and B.
2. **The per-model page** (`individual-model-pricing.md`) looks copied from the family table and gives no per-preset figure. It also lacks Text & Shapes, Redefine, Recover 3 and Wonder. Per-preset prices for our five presets are therefore the family price, unconfirmed.
3. **Astra:** the family table (40 credits per 10 s at 1080p30) and the Astra 2 page (10 frames a credit at 1080p, 6 at 4K) disagree (readings Y and X). It is also not stated whether the family table's "Astra" is Astra 2.
4. **720p:** no figure found for any video model. Our fal rate is flat at $0.30 up to 1080p.
5. **Starter** is "coming soon"; Enterprise has no published price; the terms page is 404.
6. **Plan commitment:** the monthly fee, overage and rollover were not read, so the true cost per credit at low volume is unknown.

## 6. What this means for the build
- **Images:** at Developer, direct is dearer at both sizes under every reading; at Scale it ties with fal under reading A and is dearer under B. **Video (Astra 2): at reading X, direct equals fal at Developer and is 20% cheaper at Scale; at reading Y direct is dearer.** One paid, owner-approved call would settle X against Y (the first invoice shows the credits used). The plan's T2 is the owner-approved house run; the owner's 22:15 rule says the per-step approval is the approval and there is no separate qualification run.
- If direct costs more, the customer price follows the engine cost through the same price path (nothing below cost), and the owner approves any change to the rate card (CLAUDE.md § Pricing: Topaz rows 23 cr for 5 s 1080p, 38 cr for 5 s 4K) before it ships. The ledger stores the real engine cost on every line.
- A `TOPAZ_ENABLED` switch and `TOPAZ_API_KEY` (set; production only, locked) are in `docs/plans/provider-adapters.md` section 9. Mocks only until the owner says.

## 7. Owner questions
1. **Which Topaz plan is bought: Developer ($50 a month, $0.10 a credit) or Scale ($240 a month, $0.08)?** The answer decides every "direct versus fal" line above. Scale ties or beats fal on all Astra 2 and 24 MP rows under reading X/A.
2. **Accept a dearer 48 MP image?** Developer is $0.20 (A) to $0.30 (B) against $0.16 on fal. Options: accept; cap Topaz image output at 24 MP; keep image upscale on fal until direct is cheaper.
3. **Which Starlight tier is the "Starlight-equivalent"?** Fast (6 credits per 10 s at 1080p30) or Quality (12). It is not stated whether our fal route, the Astra 2 "creative" endpoint, corresponds to any Starlight tier, so which direct row replaces it is the owner's call.
4. **Astra or Astra 2 for video?** Readings X and Y differ; confirm which model the 40-credit row means, or settle it with the first invoice.
5. **720p, Iris and Rhea:** read them before any 720p quote, or accept that 720p is priced as 1080p.
