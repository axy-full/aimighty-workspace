# Draft to final video

Gen offers Draft first for the existing draft-capable video engine. The draft is a separately quoted, watermarked 480p take. A completed draft offers a fresh quote for its clean 1080p final, followed by explicit approval. The final is another render, so fine detail may differ.

Both requests use the existing generation admission, worker, storage, meter and recovery paths. No rate, credit rule, ledger or subscription behavior changes. The final carries only the draft task as provider content; the server derives the prompt, settings, project, shot and input duration from the original tenant-scoped row. The provider task identifier remains private.

A final claim and its generation row are written together. Concurrent requests cannot create two finals. A replay follows the existing request. A missing acknowledgement is checked before another request is considered. A failed attempt frees the draft only when the stored outcome has no retained charge; a missing or uncertain final never frees its claim.

Drafts can produce a final during the provider retention window, with a small submission margin before expiry. The deadline is checked again before dispatch, including for held work. Original drafts and final takes remain in the project library after this deadline. Gen, Takes, Library and the asset inspector preserve the relationship. Recreate starts from the draft.

Unit validation uses mocked engine responses and isolated local workspaces for provider request shape, independent quotes and receipts, expiry, concurrency, replay, tenant isolation and changed approvals. Browser checks for all supported screen sizes are written but remain unrun in this saved branch. The full unit gate also needs rerunning after the recovery-key compatibility fix. No live provider qualification is claimed. A separate draft control in the Rig shot editor is outside this release; its existing generation behavior remains available.

Provider contract: [draft workflow](https://docs.byteplus.com/en/docs/ModelArk/2607688) and [task API](https://docs.byteplus.com/en/docs/ModelArk/1520757).
