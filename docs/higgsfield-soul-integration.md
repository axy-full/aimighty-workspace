# Higgsfield Soul integration

Soul Character generation is disabled until an operator explicitly enables it and supplies verified positive prices for both supported sizes. There is no default generation price.

Set these private server environment variables only after verifying the production account's access and quote for `higgsfield-ai/soul/character`:

```dotenv
HF_SOUL_CHARACTER_ENABLED=1
HF_SOUL_CHARACTER_USD_720P=<verified USD for one 720p image>
HF_SOUL_CHARACTER_USD_1080P=<verified USD for one 1080p image>
```

Use the authenticated non-generating estimate endpoint documented by Higgsfield to verify prices. The displayed Soul 2 Standard and Soul Standard prices do not establish a Soul Character price. The application's mock tests use synthetic rates solely to exercise the billing pipeline.

Credentials use the existing workspace vendor-key store under `higgsfield` as `KEY_ID:KEY_SECRET`, or the deployment's private `HF_CREDENTIALS` for workspaces entitled to platform keys. Credentials never enter client code. The binding records a credential fingerprint; a changed connection cannot submit or poll an existing binding until its original connection is restored or its provider outcome is reconciled.

Training acknowledgements also retain their known provider UUID in an independent platform receipt. A missing or unfamiliar status does not discard that UUID. An uncertain submission without a UUID cannot safely be matched by name or by listing account identities; it stays unresolved without another paid POST. Keep the original provider connection available until training and generation settle and any requested remote identity purge finishes.

## Contract and availability

The implementation uses `POST https://api.higgsfield.ai/higgsfield-ai/soul/character`, documented in the [official supplementary OpenAPI](https://docs.higgsfield.ai/docs/openapi.json). It sends the server-resolved `custom_reference_id`, `custom_reference_strength`, the prompt, a supported aspect ratio, `resolution` (`720p` or `1080p`), and `batch_size: 1`. Prompt enhancement is disabled to preserve the application's final prompt. Additional generation reference images are not exposed by this integration.

The current Console's Soul Character model page returned 404 during documentation review on 17 September 2026. Soul 2 Standard and Soul Standard's model-specific schemas omit `custom_reference_id`. Their endpoints are therefore not substituted. [Higgsfield's source-priority guidance](https://docs.higgsfield.ai/docs/llms.txt) identifies model-specific Console documentation as authoritative and OpenAPI as supplementary. The enable flag is an operator assertion that this exact contract is available for the configured account; implementing the adapter does not establish production account access.

Soul ID training has a separate [custom-reference contract](https://console.higgsfield.ai/models/soul-id/api-reference) on `dev-api.higgsfield.com` with legacy authentication headers. The generation adapter uses the documented `Authorization: Key KEY_ID:KEY_SECRET` header on `api.higgsfield.ai`. These hosts and contracts are kept separate.

## Studio workflow

Open Characters or Elements, choose **Soul ID**, and select uploaded or completed generated portraits of one character. Particl accepts 1–40 JPEG, PNG or WebP originals; Higgsfield's API permits up to 100. Several clear views provide better identity coverage than a single image. Soul ID is not a prop, product or environment trainer.

Review the server quote and rights consent, then create the identity. Training remains visible after leaving or reloading. When ready, attach it as a normal character/element asset and add that asset to the canvas. With the verified generation gate enabled, choose **Soul Character** in the node's generation dialog and adjust likeness strength. Other engines continue to use its original portrait reference. Completed images enter the existing takes/library and full-resolution download flow.

Workspace owners connect their own account under **Workspace → Engines → Higgsfield**. The platform's legacy workspace uses private deployment environment variables. The new connection form saves the encrypted key pair without returning it. A saved key is configuration, not evidence of successful live training or generation.

Training is quoted at the linked page's $2.50 per custom-reference request, translated through existing credit terms. Accepted training requests retain this charge even if training later fails; the UI states this before consent. The separate custom-reference API does not document a training refund policy. A definitive pre-acceptance rejection releases the reservation. An ambiguous submission retains it for reconciliation and never automatically buys another attempt.

## Recovery and billing

Admission resolves a local identity in the requesting tenant, checks that it is complete and bound to the same credentials, and saves its provider UUID and quoted price on the generation. The client supplies only the local identity ID. Soul identity training is for a single face; generic products and locations remain ordinary reusable elements.

The paid submission shares the existing permanent render claim and spend reservation. A POST is never automatically retried after an ambiguous response. Once returned, its request UUID and status URL are retained privately in both the generation and an independent platform receipt before collection. The receipt restores a missing tenant handle after a database outage and is acknowledged only after terminal billing settlement. An unknown submission without a receipt remains pending for operator reconciliation; it is never resubmitted or automatically refunded. Polling accepts only HTTPS status URLs on `api.higgsfield.ai` with the exact matching `/requests/{UUID}/status` path and no redirects. Collection remains available if new submissions are subsequently disabled.

The collector downloads the returned full image, bounds download size, and uses the existing lossless PNG storage path. It settles the saved generation price, not a newly configured rate. Explicit provider failures, moderation rejection, and cancellation settle at zero; network, malformed-result, credential-rotation, and storage failures retain the request and reservation for reconciliation. Neither the provider UUID, connection fingerprint, provider status URL, nor vendor price snapshot is included in the public generation parameters.

See [requests](https://docs.higgsfield.ai/docs/concepts/requests), [authentication](https://docs.higgsfield.ai/docs/authentication), and [retry guidance](https://docs.higgsfield.ai/docs/concepts/errors) for the provider lifecycle.
