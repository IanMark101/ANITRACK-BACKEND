# AniTrack Backend

Account management, SMTP setup, shared AI budgets, limits, monitoring, backups and CI are documented in [the web operations guide](docs/OPERATIONS.md). After pulling these changes, stop the API, regenerate Prisma's client, and deploy the committed additive migration before restarting it.

All catalog, discovery, anime-detail and Anime Assistant endpoints require authentication. The public landing page describes these capabilities and links to login/registration; guests cannot use them or invoke the feature APIs.

Moving to another PC? Follow [the complete setup guide for both repositories](https://github.com/IanMark101/ANITRACK-FRONTEND/blob/main/docs/SETUP-ANOTHER-DEVICE.md).

Anime discovery uses Kitsu's public API; no additional API key is required. Existing and custom watchlists remain in PostgreSQL. After updating this checkout, run `npm run db:generate` and `npm run db:deploy` before starting the API.

The optional Anime Assistant uses a backend-only `GEMINI_API_KEY` from Google AI Studio. Set it in this folder's `.env` and restart the API. `GEMINI_MODEL` defaults to `gemini-3.5-flash-lite`, using Google's Interactions API with structured JSON output. Ordinary discovery and watchlists work without this key. Never place it in a `VITE_` variable.

The assistant tries `gemini-3.5-flash-lite`, then `gemini-3.1-flash-lite`, then `gemini-3.6-flash` when a model is temporarily unavailable. `GEMINI_MODEL` selects the primary; optional `GEMINI_FALLBACK_MODELS` accepts up to four comma-separated backup IDs, or `none` to disable backups. The default works with the existing backend key; no additional key is needed. See [the model and quota audit](docs/AI-AUDIT.md) for verification and remaining usage controls.

Express and Prisma API with PostgreSQL persistence, authentication, catalog management, and private watchlists. This folder can be the root of the `anitrack-backend` GitHub repository.

Use Node.js 22.12 or newer. Run commands from this folder:

```sh
npm install
cp .env.example .env
npm run db:generate
npm run db:deploy
npm run db:seed
npm run dev
```

In PowerShell, use `Copy-Item .env.example .env` if preferred. If `.env` is already configured, keep it. Set `DATABASE_URL` to the pooled Neon URL, `DIRECT_URL` to the direct Neon URL, and `JWT_SECRET` to a random secret of at least 32 characters. Use `CLIENT_ORIGIN=http://localhost:5173`, `PORT=3001`, `NODE_ENV=development`, and `TRUST_PROXY=0` locally. Both connection URLs must keep Neon's TLS parameters.

The API runs on port 3001. `GET /api/health` checks database connectivity. The frontend runs separately. Seed inserts ten shared catalog titles; it creates an optional member only when `SEED_USER_EMAIL` and `SEED_USER_PASSWORD` are explicitly configured.

Authentication refresh and collection transactions allow up to 10 seconds to acquire a transaction and 20 seconds to complete it, accounting for hosted PostgreSQL round trips. Temporary database errors return a retryable failure without clearing the refresh cookie. Invalid or expired refresh credentials still clear it. This fixes the observed P2028 timeout followed by unexpected logout; it does not make database outages invisible.

```sh
npm run lint
npm run typecheck
npm test
npm run build
npm start
```

For integration tests, put `TEST_DATABASE_URL` in ignored `.integration.env`, targeting an already migrated dedicated test database, and run `npm run test:integration`. Alternatively, `npm run test:isolated` creates a fresh random schema in the configured development database, migrates it, runs both integration scenarios, and removes only that schema afterward. This requires schema-creation permission. Both approaches cover authentication, private ownership, idempotent imports, concurrent progress updates, and saved-data fallback during provider downtime. External metadata is mocked in integration tests. The poster fixture is included here; tests do not need frontend source. Never target a production database.

## Discovery and progress endpoints

- `POST /api/assistant` accepts `{ "mode": "identify", "message": "A stretchy pirate with a straw hat", "context": [], "excludeIds": [] }`. Use `recommend` for preferences. The assistant suggests real titles, retrieves matching Kitsu records, and ranks recommendations against catalog metadata. Genre, exclusion, episode, completion, and format constraints are checked server-side. Vague descriptions can return a follow-up question. This does not require mirroring Kitsu or training a model on this database.
- `GET /api/discovery?q=...&view=popular|top|seasonal|upcoming&page=1&genre=...` returns paginated title metadata. Seasonal browsing also accepts `year` and `season` (`winter`, `spring`, `summer`, `fall`).
- `GET /api/discovery/:externalId` returns detailed metadata, or a saved snapshot if the provider is unavailable and this anime was previously imported.
- `GET /api/discovery/:externalId/episodes?page=1`, `/related`, and `/similar` provide episode information, anime relations, and category-based suggestions. Suggestions are not personalized recommendations.
- `POST /api/watchlist/import` accepts `{ "externalId": "46474" }`; metadata is fetched server-side. Repeated imports return the existing entry. Community scores never overwrite personal ratings.
- `PATCH /api/watchlist/:id` accepts `episodesWatched` as a non-negative integer within a known episode total. `POST /api/watchlist/:id/progress` accepts `{ "delta": 1 }` or `{ "delta": -1 }` and uses a serializable transaction with conflict retries.
- `GET /api/watchlist/calendar?week=YYYY-MM-DD` returns available recent episode dates for up to 20 recently updated imported titles marked Watching. This is not a complete historical release archive; missing dates and exact streaming times are not inferred.

Provider requests time out after 8 seconds, use a bounded in-memory cache (10 minutes for discovery, 6 hours for details, 1 hour for episodes, 1 day for relations), and coalesce concurrent identical requests. Import stores the selected title's metadata in `Anime.details`; `provider` and `externalId` identify it uniquely. Per-user episode progress belongs to `WatchlistEntry`, with existing entries starting at zero. Unknown episode totals remain null.

Assistant requests allow up to 1,200 characters plus three previous user messages, and up to 300 saved Kitsu IDs to exclude. Only descriptions/preferences and candidate catalog metadata are sent to Gemini; account details and excluded watchlist IDs are not sent. Interactions use `store: false`; AniTrack does not persist conversations. The authenticated endpoint limits each IP to 12 requests per five minutes and allows three concurrent searches. Each stage tries at most three distinct available models once, with a 20-second per-attempt timeout and a shared 60-second search deadline. Quota errors cool a model down for at least 60 seconds, other temporary failures for 30 seconds, and missing models for five minutes. A longer `Retry-After` is respected up to 24 hours. Key, billing, request, and failed/blocked interaction errors stop immediately. Browser disconnects cancel in-flight generation and prevent further attempts. Cooldowns are local to this server process and reset on restart. Suggestions can be incomplete or mistaken; catalog verification confirms a title exists, not that every remembered clue is correct. See [Google's Interactions API](https://ai.google.dev/api/interactions-api).

The completion filter uses the Kitsu record's airing status. A finished season does not guarantee the entire franchise's story has concluded.

Commit the package manifest, lockfile, source, tests, Prisma schema, migrations, and catalog seed. Never commit `.env`, `.integration.env`, `node_modules/`, or `dist/`. Production requires HTTPS, the exact frontend origin, and correctly configured proxy trust. Use same-site hosts or a frontend API proxy for refresh cookies.
