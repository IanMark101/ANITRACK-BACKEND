# Web release and operations

## Install and migrate

Use Node 24 and the committed lockfile. Stop the backend on Windows before generating Prisma's client, because its loaded DLL cannot be replaced.

```powershell
npm ci
npm run db:generate
npm run db:deploy
npm run lint
npm run typecheck
npm test
npm run build
npm start
```

The 20261030000000 migration adds a nullable email verification timestamp, one-time account tokens, and daily AI usage. Existing users and watchlists are preserved. As of 2 November 2026, all workspace access requires verified email, including existing accounts whose timestamp is null. These accounts must verify through the check-email screen; no accounts are automatically marked verified. The Account page provides profile changes, password changes and confirmed account deletion. Password changes/reset revoke every session for that user. Account deletion cascades through their private entries, custom titles, sessions and account tokens; shared catalog records remain.

## Authentication boundary

Catalog reads and metadata, discovery (including details, episodes, related and similar titles), Anime Assistant, watchlists, Collections and admin endpoints require a valid session AND a verified email before accessing handlers or external providers. Middleware reads the current verification timestamp from PostgreSQL on each protected request; an existing token or a changed frontend cannot bypass it. Unverified sessions receive 403 / EMAIL_VERIFICATION_REQUIRED. They may only inspect their own session, resend verification, log out, change/reset a password or delete their account. Recovery endpoints and health checks retain their existing public/session boundaries. The frontend's public landing page contains descriptions and login/registration links, with no live catalog queries or usable application features.

Registration creates a restricted session and attempts to send a verification link. The response's verificationEmailSent flag reports whether delivery succeeded. A failed send keeps the pending account recoverable without granting workspace access or claiming delivery. Resends serialize on the user row and allow at most one verification token per minute across processes. Failed delivery removes only that new token; previous valid links remain usable. Verification unlocks access without minting a privileged JWT claim. There is no new migration for this enforcement change.

## Collections

The additive `20261030010000_private_collections` migration introduces private collections and ordered watchlist memberships. Existing watchlists remain intact. Authenticated `/api/collections` endpoints support list/search/pagination, create, rename/description, detail, delete, add/remove saved titles, and exact-set reordering. Every operation checks the current owner. Limits are 20 collections per user and 100 saved titles per collection. The same saved title can belong to several groups. Removing a group leaves the watchlist unchanged; removing a saved entry or deleting its account cascades through memberships.

## SMTP configuration

Choose an SMTP provider and verify the sender address/domain. Put credentials only in the backend `.env` or hosting secret store. Configure `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD` and `MAIL_FROM` using `.env.example`. Port 587 requires STARTTLS; use `SMTP_SECURE=1` for implicit TLS on port 465. Certificate verification stays enabled. `MAIL_FROM` is an email address, without a display name. Links always use `CLIENT_ORIGIN`, never the incoming Host header.

When SMTP is absent, requesting reset/verification returns an actionable unavailable message. Newly registered and previously unverified users remain blocked from the workspace until delivery is configured and verification completes. Already verified users continue to work. Reset requests return the same generic response for existing and nonexistent addresses, and delivery happens asynchronously. Delivery failures log no address or token. Reset links expire after 30 minutes; verification links after 24 hours. Only hashes are stored, and links are consumed atomically once. Email links carry the token in a fragment, which the frontend removes from browser history after reading it. GET navigation does not consume a link. Configure CLIENT_ORIGIN to the actual frontend address before sending links.

## Resource limits and AI usage

`COLLECTION_LIMIT` defaults to 500 titles per user. Existing oversized collections are retained; users must remove titles before adding more. Concurrent creates/imports serialize on the user row before checking the limit. Re-importing a saved title remains idempotent at the limit. New uploaded covers are limited to 256 KB; existing saved images remain readable.

`GET /api/anime` accepts `page` and `limit` (maximum 100) and returns `hasNext`. Private watchlist responses contain at most 20 entries per page; the frontend gathers the pages before replacing its current collection. Summary reads omit saved provider JSON. Poster metadata is limited to 20 choices.

Every Gemini generation, including fallbacks, reserves budget in PostgreSQL before contacting Google. Conditional database updates enforce `ASSISTANT_DAILY_GENERATIONS` (default 100) and `ASSISTANT_DAILY_BUDGET_USD` (default 5) across API instances. Zero disables new calls. Daily counters use UTC. Reservations are deliberately retained for failed/cancelled calls; successful responses also record reported input/output/thinking tokens. No message contents are stored in usage records. An administrator can inspect the last 30 days at `GET /api/admin/usage`.

The dollar limit is an application estimate using configured maximum input/output prices and conservative token reservations. Verify that `ASSISTANT_INPUT_USD_PER_MILLION` and `ASSISTANT_OUTPUT_USD_PER_MILLION` cover every configured fallback model's current prices, and configure provider-side billing controls too. This accounting does not cover use of the same Google project by other applications or provider pricing changes. The existing IP rate limit and three-search concurrency limit remain process-local; the persistent generation budget is shared.

## Monitoring and maintenance

`GET /api/live` checks that the process responds. `GET /api/health` also checks PostgreSQL. Every response includes `X-Request-Id`. Slow requests and server failures emit JSON with request ID, method, status and duration; bodies, query strings, emails and credentials are omitted. `GET /api/admin/metrics` returns process-local request/error/slow counts and uptime and requires administrator authentication. Configure your hosting log retention and an external health monitor around these endpoints.

Hourly maintenance removes expired refresh/account tokens and usage records older than 90 days. Revoked refresh rows remain until their original expiry to preserve replay detection. A failed cleanup is logged and retried at the next interval.

## Backups and recovery

Verify retention and point-in-time recovery in the Neon console before production. Provider settings cannot be established from this repository. Install PostgreSQL client tools compatible with the server, then run `npm run db:backup`. The command uses `DIRECT_URL`, writes a uniquely named custom-format archive into ignored `backups/` (or `BACKUP_DIR`), and checks that `pg_restore --list` can read it. Connection passwords are passed through environment variables, not command arguments.

Store backups in access-controlled, encrypted storage outside this computer; they contain account data and password hashes. Never commit them. Periodically create a separate restore-test database, restore the archive into that database with `pg_restore --no-owner --dbname=RESTORE_TEST_CONNECTION archive.dump`, and check row counts and application login/watchlist reads. Never restore over the live database as a test. Archive readability alone does not establish recoverability. Record the restore date, archive, counts and recovery time, then delete the disposable restored database. This machine does not currently have `pg_dump`/`pg_restore`, so a real backup/restore drill remains an operator setup task.

## Automated verification

GitHub Actions runs lint, typecheck, unit tests, builds and advisory checks. Backend CI migrates a disposable PostgreSQL service and runs integration tests. `npm run test:isolated` creates a random schema in the configured development database and removes only that schema in `finally`. Its account lifecycle test creates and deletes a uniquely named temporary account and exercises reset, verification, revocation, deletion and concurrent usage limits. No real email is sent.

The frontend's `npm run test:e2e` exercises verification gating, account journeys, the More menu and a 390px mobile layout against mocked API responses. It launches its own server on port 5181 and uses installed Edge on Windows or Chromium in CI.

Build both repositories, then run `npm run test:browser` from this backend for the real browser/API/database journey. The runner creates and migrates a random schema in the configured development database, serves the frontend production build with an API proxy, and injects a captured local mailbox. It supplies ANITRACK_LIVE_SMOKE_URL and ANITRACK_TEST_MAILBOX_FILE to the browser test. Select an alternate frontend clone with ANITRACK_FRONTEND_DIR. It rejects production configuration, disables paid AI calls, never invokes SMTP, verifies account cleanup, drops only its own schema and removes its captured-mail directory in finally. Browser traces are disabled to avoid retaining account tokens. These tests do not establish real inbox delivery.

Android completion and physical-device acceptance are required by the current project plan; see the frontend's docs/PROJECT-COMPLETION-PLAN.md and docs/PROJECT-PROGRESS.md.
# Local phone email links

For development on a phone, optionally set `ACCOUNT_LINK_ORIGIN=http://YOUR_LAPTOP_IP:5173` while keeping `CLIENT_ORIGIN=http://localhost:5173`. Verification/reset emails use ACCOUNT_LINK_ORIGIN when configured. Only that exact additional origin is trusted; arbitrary LAN origins are not accepted. The frontend must listen on the Wi-Fi interface (ANITRACK_DEV_HOST=0.0.0.0), and both devices must share the network. Production account links require HTTPS. Restart the API after environment changes. SMTP secrets remain backend-only.
