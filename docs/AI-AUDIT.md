# Anime Assistant reliability verification

Original verification: 2026-10-29 (Asia/Taipei). Reliability update: 2026-11-18.

## November 18 reliability fix

The reported pirate recommendation failed after a primary-model HTTP 503 and a successful backup interpretation. Ranking then returned a valid 199-character synopsis quotation against a 180-character display limit. Rejecting that answer caused another generation attempt and a long unavailable response.

Generated summary, question, reason, and evidence strings are now shortened to their display bounds before validation. Types, result IDs, array limits, catalog existence, user filters, and exact synopsis evidence remain validated. Suggested titles are resolved first, with broad genre browsing used when no suggested title is usable. This reduces unrelated catalog context sent for ranking.

The default primary is now the working `gemini-3.1-flash-lite`, with the other configured models retained as fallbacks. Each model attempt has an eight-second limit. The complete search has an enforced 25-second deadline, including database reservation and catalog waits, and the frontend has a 30-second deadline. If detailed ranking fails after interpretation succeeds, exact suggested titles already confirmed against the catalog can be returned with a notice and a generic explanation. User cancellation still discards the request.

## Model fallback

Default order: `gemini-3.1-flash-lite`, `gemini-3.5-flash-lite`, `gemini-3.6-flash`. Both interpretation and ranking use the same ordered pool and cooldown state. Successful primary calls do not invoke backups. A failed model is skipped during subsequent stages and searches until its cooldown expires; the primary becomes eligible again afterward.

`GEMINI_MODEL` overrides the primary. `GEMINI_FALLBACK_MODELS` accepts up to four comma-separated Gemini IDs, or `none` for a single model. IDs are deduplicated. Custom models require compatible text/structured-output support and account access. The default three models were checked live with this backend key.

## Failure policy

| Condition | Behavior |
| --- | --- |
| HTTP 429 | Try the next model; at least 60-second cooldown |
| HTTP 408, 500, 502, 503, 504, network failure or per-call timeout | Try the next model; 30-second cooldown |
| HTTP 404 | Try the next model; five-minute cooldown |
| Truncated, malformed, schema-invalid, or incomplete answer | Validate a fresh answer from the next model; 30-second cooldown |
| HTTP 400, 401, 402, 403 or failed/blocked interaction | Stop; do not rotate |
| All models cooling down | Return a safe unavailable/busy message without another provider call |
| Browser client disconnect | Abort generation; do not start another model or ranking stage |

A longer `Retry-After` delay, in seconds or HTTP-date format, is respected up to 24 hours. Each stage tries at most three models once, each attempt times out after eight seconds, and the entire search shares a 25-second deadline. Interpretation and ranking each limit output to 3,000 tokens. Errors never expose provider diagnostics or keys. Conversations remain unstored by AniTrack and use `store: false` with Google.

## Verification

- 93 backend tests and 10 frontend tests passed at completion of fallback work. Backend TypeScript, ESLint, and production compilation passed.
- 28 new fallback/disconnect tests cover backup order, all eligible error codes, fatal errors, third-model success, larger configured lists, deduplication, cooldown expiry, both Retry-After formats, invalid/incomplete output, cancellation, and actual HTTP disconnect propagation.
- Seven configuration tests cover backup syntax, disabled/default settings, and invalid lists.
- Existing 13 resilience tests and 12 assistant tests remain passing. Single-model failure tests now explicitly disable backups.
- Live compatibility: all three default models returned valid structured JSON identifying One Piece.
- Live HTTP recommendation flow with a simulated primary 503: the real first backup completed both stages and returned five Kitsu titles satisfying the requested episode/airing filters, in approximately 7.5 seconds.
- Live HTTP identification flow with simulated failures for both earlier models: the real third model returned One Piece, Kitsu record 12, in approximately three seconds.

Only the outage status responses in the two failover scenarios were simulated. Backup generations and catalog requests were real. These samples establish compatibility and failover behavior, not exhaustive anime identification accuracy. No real quota exhaustion was performed.

## Remaining limits

Provider outages and shared account quota/billing restrictions can still prevent interpretation. Google applies rate limits per project, with model-specific limits. Request rate limits and model cooldowns are local to one server process. Daily generation reservations, spending bounds, and numeric token counts are stored in PostgreSQL by assistant-budget.ts. Failed attempts retain their conservative reservations. A search can attempt up to six generations within its shared deadline. Native Capacitor HTTP cancellation still needs device verification.

Sources: [Google model catalog](https://ai.google.dev/gemini-api/docs/models), [rate limits](https://ai.google.dev/gemini-api/docs/rate-limits), [retry guidance](https://ai.google.dev/gemini-api/docs/troubleshooting), [Interactions API](https://ai.google.dev/api/interactions-api).
