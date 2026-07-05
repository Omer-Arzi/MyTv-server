# My TV — Server

Backend for a personal TV series tracking app. NestJS + TypeScript + PostgreSQL + Prisma. Built to run locally, deploy to Railway, and serve a future React Native client (auth and Trakt integration are not implemented yet).

## Stack

- **NestJS** (Express platform) + TypeScript
- **PostgreSQL** via **Prisma ORM**
- **Swagger / OpenAPI** at `/docs`
- Temporary hardcoded dev-user "auth" (see below) — no real auth yet
- No external API integration yet (Trakt is planned, not wired up)

## Prerequisites

- Node.js 18+ (developed against Node 22)
- Docker (for local Postgres) — or any reachable PostgreSQL instance

## Setup

```bash
npm install
cp .env.example .env      # adjust DATABASE_URL if needed
docker compose up -d      # starts local Postgres on localhost:5433
npx prisma migrate dev    # creates the schema (also ensures the dev user exists)
npm run start:dev         # http://localhost:3000, Swagger at /docs
```

> The Compose file maps Postgres to host port **5433** (not 5432) to avoid clashing with other local Postgres containers. `.env.example` already points at 5433 — change both together if you adjust it.

## Environment variables

| Variable       | Description                                  | Example                                                        |
| -------------- | --------------------------------------------- | --------------------------------------------------------------- |
| `DATABASE_URL` | Postgres connection string used by Prisma     | `postgresql://mytv:mytv@localhost:5433/mytv?schema=public`      |
| `PORT`         | HTTP port the server listens on               | `3000`                                                           |

## Running things

### Server

```bash
npm run start:dev    # watch mode
npm run start         # no watch
npm run build && npm run start:prod   # production build + run
```

### Migrations

```bash
npm run prisma:migrate   # prisma migrate dev — create/apply a migration during development
npm run prisma:deploy    # prisma migrate deploy — apply existing migrations (CI/production)
```

### Seed data

```bash
npm run prisma:seed              # safe — only ensures the dev user row exists, never deletes anything
npm run seed:demo:destructive    # destructive — wipes the DB and loads synthetic demo series; guarded, see below
```

`npm run prisma:seed` (also auto-triggered by `prisma migrate dev`) is always safe to run, against any database, at any time — it upserts the dev user row and touches nothing else.

`npm run seed:demo:destructive` wipes every app table and reloads synthetic demo data (`Quantum Kitchen`, `Signal & Noise`). It refuses to run unless `ALLOW_DESTRUCTIVE_SEED=true` is set **and** no real imported data is detected in the database — see [`docs/dev-database-safety.md`](docs/dev-database-safety.md) for the full story (including the incident that made this necessary) and exact usage.

### Prisma Studio

```bash
npm run prisma:studio
```

Opens a local DB browser/editor at `http://localhost:5555`.

### Swagger / API docs

With the server running, open `http://localhost:3000/docs`. The spec is generated from the controllers/DTOs — see `API_CONTRACT.md` for a narrative version aimed at the future React Native client.

## Local PostgreSQL (Docker Compose)

`docker-compose.yml` defines a single `postgres:16-alpine` service, credentials `mytv` / `mytv`, database `mytv`, exposed on host port `5433`.

```bash
docker compose up -d     # start
docker compose down      # stop (keeps data in the named volume)
docker compose down -v   # stop and wipe the volume
```

## Dev "auth"

There is no real authentication yet. A `DevUserMiddleware` (`src/common/middleware/dev-user.middleware.ts`) attaches a fixed user (`id: 00000000-0000-4000-8000-000000000001`, `email: dev@example.com`) to every request. The seed script creates that exact user row so the IDs line up. Replace this middleware with a real auth guard/strategy when auth is implemented — every service already reads the user id from `req.user`, so that's the only place that needs to change.

## Project structure

```
prisma/
  schema.prisma       Database schema
  seed.ts              Safe seed (npx prisma db seed) — ensures the dev user exists, nothing else
  seed-demo.ts          Destructive demo seed (npm run seed:demo:destructive) — guarded, see docs/dev-database-safety.md
  seed-guard.ts         Shared safety-check logic for seed-demo.ts
  migrations/          Generated migrations
src/
  main.ts              Bootstrap, global ValidationPipe, Swagger setup
  app.module.ts         Root module, wires up the dev-user middleware
  prisma/               PrismaService (global, injectable)
  common/
    constants.ts         Dev user id/email
    middleware/           DevUserMiddleware
    decorators/            @CurrentUser()
    dto/                    Shared response DTOs (SeriesSummary, EpisodeSummary)
    utils/                  Cursor encode/decode for pagination
    mappers.ts              Prisma model -> DTO mapping helpers
  modules/
    home/                GET /home
    me/                  GET /me/recently-watched, /me/watch-next, /me/stale-series
    watchlist/           GET /watchlist, POST & DELETE /series/:seriesId/watchlist
    episodes/            POST /episodes/:episodeId/watch, PATCH /episode-watches/:watchId/note
```

Each module follows the same shape: `*.controller.ts` (routing + Swagger docs only), `*.service.ts` (Prisma queries + business logic), `dto/` (request/response shapes, validated and documented).

## Design notes

- **`Series.status`** (ONGOING/ENDED/CANCELED) is the show's own broadcast status. **`UserSeriesProgress.status`** (WATCHING/COMPLETED) is this user's personal progress. They're independent — finishing all aired episodes of an ongoing show marks progress COMPLETED without changing the show's status.
- **`UserSeriesProgress.nextEpisodeId`** is a cached pointer, recomputed every time an episode is marked watched. This keeps `/me/watch-next` a cheap indexed read and makes the `POST /episodes/:id/watch` response deterministic — important for the swipeable-card UX in the future mobile client (see `API_CONTRACT.md`).
- **Marking an episode watched is idempotent** (upsert on `userId + episodeId`). If a client retries after a failed request, it won't error.
- **Recently-watched pagination** uses Prisma's native cursor pagination on `EpisodeWatch.id`, base64-wrapped so it's an opaque token to clients.

## Not implemented yet (by design, per V1 scope)

- Real authentication
- Trakt integration / external series search
- Movies (series only for V1)
- Re-watch tracking (marking watched again just updates `watchedAt`)
