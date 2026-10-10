# Render jobs and provider cancel billing (research, 10 Oct 2026; read-only)

States: generations.status = held | queued | running | succeeded | failed | cancelled (no "storing"; storage is inside running, timed by store_ms). UI tray derives stages (lib/jobsTray.ts:31); no engine reports a percentage.
Queue position: our held/slots line (lib/held.ts) and provider_pool ordering (lib/providerPool.ts poolVerdict().ahead); fal queue_position is typed but dropped (lib/engines/fal.ts:98).
Typical times: generations.duration_ms / queue_ms / engine_ms / store_ms, settled_at (+ idx_gen_settled), group by model; meter_events.duration_ms via engineHealth() (lib/meter.ts:369-389); per-kind medians in lib/creditUsage.ts:90,135.
Cancel today: only Higgsfield API-key video, queued only: POST /api/generations/[id]/cancel (lib/genjutsuVideo.ts:166-193); held takes can be discarded (lib/held.ts:101-118). Cancelled/failed → meter releases reservation (cost 0).

| Provider | Cancel API | Cancellable | Billing on cancel |
|---|---|---|---|
| BytePlus Ark (Seedance) | DELETE /api/v3/contents/generations/tasks/{id} (not built) | queued only | not charged (only successful videos billed) |
| fal (Kling, Topaz) | PUT queue.fal.run/{model}/requests/{id}/cancel (not built) | IN_QUEUE removed; IN_PROGRESS "may still complete" | queued: not charged; running: docs silent |
| Higgsfield API | POST /requests/{id}/cancel (built) | queued only | docs silent; our code assumes not charged |
| xAI Grok Imagine | none | — | — |
| ElevenLabs | dubbing DELETE only | — | running API dub not refunded |
| Topaz direct (we use via fal) | DELETE /video/{id} | not completed | before processing full refund; mid-run prorated |
| Sync (only via retired sign-in) | none | — | — |
| OpenAI images | none | — | usage recorded |
| Google Veo/Imagen/Nano Banana | none | — | Veo charged only on success |
URLs: docs.byteplus.com/en/docs/ModelArk/cancel-or-delete-video-generation-tasks-api · fal.ai/docs/model-apis/model-endpoints/queue · docs.higgsfield.ai/docs/concepts/requests · docs.x.ai · elevenlabs.io/docs/api-reference/dubbing/delete · developer.topazlabs.com/reference/video/cancel-request · ai.google.dev/gemini-api/docs/veo
Takeaway for P3 Cancel: show Cancel only while the provider still has the job queued (Ark, fal, Higgsfield) with "nothing billed"; once running, Cancel is not offered (or offered as "stop waiting — the provider may still charge"); building Ark/fal cancel = money-adjacent → NEEDS AKSHAY.
Side finding: Google lists gemini-2.5-flash-image as shut down 2 Oct 2026 — check our Nano Banana model ids.
