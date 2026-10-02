# Atomik thinking models

Owner, 28 September 2026: Atomik's agentic workflow runs on Claude, OpenAI and Grok. It no longer depends on Higgsfield Supercomputer, which is not offered as an API, and it never uses a signed-in Higgsfield account.

`lib/atomikModelPolicy.ts` is the product allowlist. `VERIFIED_TEXT_MODEL_IDS` is the verified text catalogue; `ATOMIK_MODEL_IDS` is Atomik's part of it — the Anthropic, OpenAI and xAI (`spacexai/` on Gateway) families — with Claude Sonnet 4.6 first as the default. Catalogue discovery supplies availability, modality support and prices, through the existing AI Gateway routing. Both Atomik experiences filter the menu; named requests outside the allowlist fail before paid work. Auto and platform routing remain inside the allowlist. A named unavailable model is never silently substituted.

A chat saved on a model Atomik no longer offers (a Gemini model) reads as Auto, the default, with a note that says so; the stored row is not changed. A new request that names one is refused with the same reason, so a person picks again against a fresh estimate. Vision requests still require declared image support, quotes, context bounds and budget checks.

This policy does not alter generation-engine selection, customer credit pricing or already accepted job identity. Future catalogue additions require an explicit policy update with evidence.
