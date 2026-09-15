# Atomik model catalogue and reasoning

The model picker offers the Claude, OpenAI and Gemini text/planning models verified in the public AI Gateway catalogue on 15 September 2026 (83 IDs). Runtime availability and token prices still come from the connected Gateway. Model names are searchable and grouped by provider. Image generators, audio services, embeddings, Gemma and safeguard classifiers belong to other tools and are excluded from this planner.

The previous Higgsfield-only product restriction has been removed at the owner's request. `lib/atomikModelPolicy.ts` holds the verified set; explicit unavailable choices never silently switch to another model. Auto retains its established production model shortlist before considering other available planners.

Reasoning effort is separate from response detail (Quick, Considered, Deep). The model's capability metadata determines its choices; older models with fixed thinking budgets show token counts. Provider default leaves reasoning controls unset. Models without adjustable reasoning expose only the default. Unsupported combinations are rejected before a claim or credit reservation.

The shared reasoning compiler builds the exact Gateway request controls. Native provider options are used where Gateway's generic effort translation would change the requested setting. Output reservations include the bounded reasoning allowance and the catalogue’s applicable context-tier token rates. Malformed or uncovered declared price tiers cannot become a free quote. New effort-controlled requests require an approved credit ceiling. Their application safety ceilings default to $10 per request and $100 in Atomik work per production, so premium models fit. Explicitly configured lower ceilings remain effective; actual workspace balances, monthly limits and project budgets are still enforced by the atomic reservation. Older requests without effort retain the former $0.25/request and $5/production guards. Credit pricing is unchanged. Requests exceeding any applicable cap are declined before inference. Selecting maximum effort does not promise an unlimited thinking duration or an unlimited token budget.

Workbench quotes include the selected model, effort and total output ceiling. Paid requests persist these controls and the provider request before execution; identity conflicts are rejected. Pending requests from older deployments retain their original bytes and fingerprints. Plans retain the requested effort as provenance. Legacy writing tools also quote before submission and retain their older $1 request guard for requests without effort. The worker permits up to 270 seconds within a 300-second function, and history does not expire a running job until six minutes. Ambiguous provider results retain their reservation and are not automatically submitted again.

Sources:

- [Gateway model catalogue](https://ai-gateway.vercel.sh/v1/models)
- [Gateway reasoning controls](https://vercel.com/docs/ai-gateway/models-and-providers/reasoning)
- [Gateway Chat Completions reasoning](https://vercel.com/docs/ai-gateway/sdks-and-apis/openai-chat-completions/reasoning)
- [Gateway provider options](https://vercel.com/docs/ai-gateway/models-and-providers/provider-options)
- [OpenAI model guidance](https://developers.openai.com/api/docs/guides/latest-model)
- [Claude effort](https://platform.claude.com/docs/en/build-with-claude/effort)
- [Gemini thinking](https://ai.google.dev/gemini-api/docs/thinking)

Verification must distinguish catalogue/contract checks and mocked execution from real provider qualification. This release does not certify that every model has completed a paid production test.
