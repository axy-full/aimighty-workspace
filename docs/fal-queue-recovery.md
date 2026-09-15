# fal queue routing and recovery

Submission uses the complete endpoint (for example `fal-ai/topaz/upscale/image`). Status and result retrieval use the queue application's owner and alias (`fal-ai/topaz/requests/<id>`), without the submission subpath. The optional `workflows` and `comfy` namespaces precede the owner and alias. This follows the provider's [queue client](https://github.com/fal-ai/fal-js/blob/main/libs/client/src/queue.ts) and [endpoint parser](https://github.com/fal-ai/fal-js/blob/main/libs/client/src/utils.ts), checked on 15 September 2026.

The internal paid Topaz qualification exposed a 405 from polling a complete submission endpoint. The job had already been accepted, and its request ID and credit reservation remained intact. Correcting the status/result URL lets the existing reconciliation path collect that same request. It requires no database rewrite, new generation, changed quote, or second payment.

`tests/unit/falQueue.spec.ts` exercises the real fal HTTP adapter with an isolated transport, including nested Topaz/Astra/Kling/Bria/Luma endpoints, ordinary identity endpoints, optional namespaces, malformed identifiers and a failed read followed by successful collection. The existing generation-admission tests separately exercise durable handles, collection leases and exactly-once settlement. Mock request IDs alone do not test provider URLs.

A successful synthetic provider call proves that one configuration can deliver and settle. It does not qualify the provider's whole catalog, degraded source quality, peak capacity, latency SLA, or vendor invoice accuracy.
