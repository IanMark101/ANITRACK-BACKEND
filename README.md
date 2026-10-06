# AniTrack Backend

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

```sh
npm run lint
npm run typecheck
npm test
npm run build
npm start
```

For integration tests, put `TEST_DATABASE_URL` in ignored `.integration.env`, targeting an already migrated dedicated test database, and run `npm run test:integration`. The poster fixture is included here; tests do not need frontend source. Never target a production database.

Commit the package manifest, lockfile, source, tests, Prisma schema, migrations, and catalog seed. Never commit `.env`, `.integration.env`, `node_modules/`, or `dist/`. Production requires HTTPS, the exact frontend origin, and correctly configured proxy trust. Use same-site hosts or a frontend API proxy for refresh cookies.
