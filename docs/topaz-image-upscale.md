# Topaz image upscaling

Gen → Images → Engine → Topaz Image Upscale accepts an original workspace image or a new upload. Completed images also offer **Upscale image** in the take actions. The output is a new reusable take; the original is retained.

The precision choices are Standard V2, High Fidelity V2, Low Resolution V2, CGI and Text Refine. Scale is 1×, 2× or 4×. Face enhancement is opt-in, with adjustable strength and zero creative face reconstruction. Output is PNG at the source aspect, stored byte-for-byte without stripping color metadata. Provider files are limited to 200 MB before storage. Animated images and transparency require exporting an individual, flattened frame first. Inputs are PNG/JPEG/WebP up to 30 MB; outputs are bounded at 48 megapixels and 16,384 pixels per side.

The server reads the original file's metadata before pricing; neither client dimensions nor a delivery JPEG determine the price. It chooses the provider's output band (up to 24 MP or 48 MP), applies the existing credit formula, and binds the quote to the source and settings. Any change requires a fresh quote. Source ownership, membership, caps, quota and credit reservation use the existing admission gates. Saved parameters retain the input reference and upscale settings for the worker and subsequent reuse.

The paid submit has one permanent claim. The provider queue handle is stored before polling, and polling or output-storage failures retain that handle and the credit reservation. Reconciliation uses only that existing handle, with a per-job lease and the normal atomic settlement record. A lost browser response replays the same idempotency key. A lost provider submission acknowledgment remains uncertain and cannot be submitted again automatically.

Provider prices verified on 14 September 2026: $0.08 per image up to 24 MP output and $0.16 up to 48 MP. The standard 1.5× credit formula therefore quotes 2 cr and 3 cr. Subscription plans and credit pack terms are unchanged.

Sources: [official endpoint and prices](https://fal.ai/models/fal-ai/topaz/upscale/image), [official input schema](https://fal.ai/models/fal-ai/topaz/upscale/image/api).

Astra 2 is the separate video model. This image tool uses Topaz precision image models; it does not label them Astra. Video's delivered-resolution and frame-rate pricing is a separate implementation follow-up. No live paid Topaz render has been rehearsed: automated verification uses local originals, real admission/ledger/storage, and mocked provider responses. Production rendering quality and account billing still need a bounded internal provider rehearsal.
