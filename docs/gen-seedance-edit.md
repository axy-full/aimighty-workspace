# Seedance 2.5 Edit in Gen

Gen's video model picker exposes Seedance 2.5 Edit. Completed video takes also have an Edit clip action. The editor accepts an uploaded source or a completed workspace take, up to eight image references from uploaded/generated assets, edit direction, 480p/720p output and native audio. It submits the existing `dreamina-seedance-2-5-260628` provider model with `task: edit`; it never sends a synthetic model ID.

Seedance 2.0 (`dreamina-seedance-2-0-260128`) offers `edit` too. It was verified with one live render on 23 September 2026: the edit quoted, was admitted and settled on the same path as 2.5, with the source's shape measured from the stored original because the render had no recorded ratio; the 4 s edit took about 15 minutes to finish. Its `extend` has not been run live.

The free `/api/generate/quote` route uses the same server preparation as pipeline admission. It returns only the public quote, not compiled private/provider state. Source ownership, dimensions, duration, reference identities, account scope and current pricing are validated before quoting. Submission rechecks the quote fingerprint and credit ceiling before admission. Changing direction or settings in the browser requires a fresh quote.

Locked Seedance estimates and saved parameters now use the source's known aspect and actual duration. The provider adapter still sends its required `adaptive` ratio and `-1` edit duration. Unknown source metadata fails closed; an adaptive generated take without known dimensions can be downloaded and uploaded for metadata extraction. Portrait uploads use their shorter dimension for the source resolution band. This corrects duration/shape underestimation without changing the accepted credit formula or rate card.

The exact body, request key and displayed source/reference context are stored before submitting. A lost response exposes Recover edit after reload and reuses that request. Server idempotency retains the original generation identity. A changed quote is refused before any new paid reservation.

Provider references: [BytePlus Seedance 2.5 prompt guide](https://docs.byteplus.com/en/docs/ModelArk/2607689) and [Higgsfield's Seedance guide](https://higgsfield.ai/creator-hub/help-center/ai-models/how-do-i-use-seedance), checked 14 September 2026. The BytePlus guide's detailed parameter contract is recorded in `lib/tasks.ts` and `lib/ark.ts`. Generative editing is not a deterministic conform; inspect returned shots before approval. No mask painting or guarantee of unchanged pixels is represented by this release.
