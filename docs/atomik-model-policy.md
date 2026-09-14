# Atomik thinking models

As requested by the owner, Atomik is limited to thinking models offered by Higgsfield Supercomputer. The verified launch set is Claude Sonnet 4.6, Claude Opus 4.6, Claude Opus 4.7, GPT-5.5 Pro and Gemini 3.1 Pro (served as Gemini 3.1 Pro Preview by Gateway). The exact serving names remain visible.

Verified 14 September 2026 against [Higgsfield's Supercomputer overview](https://higgsfield.ai/supercomputer-intro) and the [public AI Gateway catalogue](https://ai-gateway.vercel.sh/v1/models). Higgsfield's [help page](https://higgsfield.ai/creator-hub/help-center/tools/how-do-i-use-supercomputer) mentions additional provider families without exact model versions; these are not sufficient evidence to add models. Its full live selector currently requires sign-in.

`lib/atomikModelPolicy.ts` is the product allowlist. Catalogue discovery supplies availability, modality support and prices. Both Atomik experiences filter the menu; named requests outside the allowlist fail before paid work. Auto and platform routing remain inside the allowlist. A named unavailable model is never silently substituted. Vision requests still require declared image support, quotes, context bounds and budget checks.

This policy does not alter generation-engine selection, customer credit pricing or already accepted job identity. Future catalogue additions require an explicit policy update with evidence.
