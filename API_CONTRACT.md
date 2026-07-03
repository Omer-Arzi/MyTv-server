# API Contract — for the React Native client

This is a narrative summary of the backend API for whoever builds the mobile app. The full, always-up-to-date spec is served from the running backend at **`/docs`** (Swagger UI) and **`/docs-json`** (raw OpenAPI JSON) — treat this file as an orientation guide, not the source of truth.

Base URL (local dev): `http://localhost:3000`

## Auth (current state)

There is no login yet. Every request is treated as the same hardcoded dev user. Don't build a login screen against this backend yet — just call the endpoints directly. When real auth lands, the only client-side change should be adding an `Authorization` header.

## Data model the client should know about

- **Series** — a show. Has its own `releaseStatus`: `UNKNOWN` / `RETURNING` / `ENDED` / `CANCELLED` / `IN_PRODUCTION` — the show's *public* broadcast status, provider-derived (TMDb) and never affected by what any user has watched. `UNKNOWN` until an enrichment pass confirms it.
- **Season / Episode** — standard hierarchy. Episodes are identified by `id`, but also carry `seasonNumber` + `episodeNumber` for display.
- **Images**: `Series.posterUrl` (portrait) and `Series.backdropUrl` (wide "fanart"-style, suited to a detail-screen hero header) are separate fields — a card can want either or both. `Episode.imageUrl` is a per-episode still/thumbnail. All three are nullable independently and null until enrichment has run for that series — always render a placeholder rather than assuming presence.
- **A user's personal status on a series** is `userStatus`, separate from the series' own `releaseStatus`: `UNKNOWN` / `WATCHLIST` / `WATCHING` / `PAUSED` / `DROPPED` / `CAUGHT_UP` / `COMPLETED`. `WATCHLIST`/`PAUSED`/`DROPPED` are user-controlled; `WATCHING`/`CAUGHT_UP`/`COMPLETED` are computed. `CAUGHT_UP` means "watched everything that exists so far, but the show is still airing — more may come"; `COMPLETED` means "watched everything, and the show itself is confirmed over." A fresh watch always resets `userStatus` to `WATCHING` (or `CAUGHT_UP`/`COMPLETED` if that was the last known episode) regardless of what it was before — so watching an episode is always enough to "resume" a `PAUSED`/`DROPPED` series without a separate action.
  - **Client note on trusting `WATCHING`/`CAUGHT_UP`/`COMPLETED`:** TMDb enrichment has now been applied for a real subset of series (currently 184 of 433) — for those, these three values are confirmed against a real, full episode catalog and are safe to treat as accurate. For every other series, `WATCHING` is still a *placeholder* left over from the TV Time import — it only means "some episodes were watched, and the show isn't archived," not "actively/currently watching," and those series will never show `CAUGHT_UP`/`COMPLETED` until they're enriched too. There is currently no API field that tells the client *which* case a given series is in — `GET /series/:id`'s `externalIds` being non-null is the closest available signal ("this series has been matched, so its status is trustworthy"); a null `externalIds` means "placeholder, treat with the caveat above." Worth adding as an explicit boolean if this distinction turns out to matter for UI copy.
- **"Haven't watched for a while" is not a status value anywhere in the API.** It's `GET /home`'s `staleSeries` section — a filter MyTv computes fresh on every call (`userStatus` is `WATCHING` or `CAUGHT_UP`, and `lastWatchedAt` is older than the threshold), not a `userStatus` a series can be "in." Don't look for a `STALE` enum value; there isn't one and won't be.
- **EpisodeWatch** — one record per watched episode, optionally with a note attached.

## The swipe-to-watch flow (episode cards)

This is the interaction `POST /episodes/:episodeId/watch`'s response shape is optimized for:

1. User swipes an episode card right.
2. Client immediately shows a loading state on that card and calls `POST /episodes/:episodeId/watch`.
3. **On success**: the response includes `nextEpisode` (or `null`) for the *same series*. The client replaces the swiped card's content with `nextEpisode` in place — no extra fetch, no layout jump. If `nextEpisode` is `null`, `seriesCompleted` is `true` and the client should remove the card; check the response's `userStatus` to tell a `CAUGHT_UP` show ("nothing to watch *yet*") apart from a genuinely `COMPLETED` one ("nothing more is coming") if the UI wants to say something different for each.
4. **On failure**: the client animates the card back to its original position. Retrying is safe — marking watched is idempotent, so a retried call after a network failure won't create a duplicate watch or double-advance the series.

This same shape is what powers `watchNext` on the home screen, so a "next episode" card always looks the same whether it came from `/home` or from a fresh `/episodes/:id/watch` call.

## Cursor pagination (`GET /me/recently-watched`, `GET /series`)

Both list endpoints that can grow large use the same opaque-cursor shape:

```
GET /me/recently-watched?limit=10
-> { items: [...], nextCursor: "abc123..." }

GET /me/recently-watched?limit=10&before=abc123...
-> next (older) page

GET /series?limit=20
-> { items: [...], nextCursor: "xyz789..." }

GET /series?limit=20&cursor=xyz789...
-> next page
```

`nextCursor` is `null` when there are no more items. Don't parse or construct cursor values on the client — treat them as opaque strings round-tripped from the server. Note the query param name differs by endpoint (`before` for recently-watched, since it's explicitly "older than"; `cursor` for the series library, which has no inherent time direction) — check each endpoint's own reference below.

## Error shape

Standard Nest validation/HTTP-exception format:

```json
{ "statusCode": 400, "message": ["limit must not be greater than 50"], "error": "Bad Request" }
```

or for a single message:

```json
{ "statusCode": 404, "message": "Episode <id> not found", "error": "Not Found" }
```

## Endpoint reference

Full request/response schemas, including field-level descriptions and examples, are in Swagger at `/docs`. This section covers what each endpoint is *for*, not the exhaustive shape.

### `GET /home`

- **Purpose**: single call for the app's first screen — everything above the fold, no waterfall of requests.
- **Request**: no params.
- **Response**: `{ recentlyWatched: RecentlyWatchedItemDto[], watchNext: WatchNextItemDto[], staleSeries: StaleSeriesItemDto[] }`. `recentlyWatched` is capped at 10 (use `GET /me/recently-watched` to page further); `watchNext` and `staleSeries` are returned in full (not paginated — see known limitations). Every item embeds full `series` and `episode`/`nextEpisode` objects, including `posterUrl`/`backdropUrl`/`imageUrl` — no follow-up requests needed to render a card.
- **Mobile UI usage**: render as three horizontally- or vertically-scrolling sections in that order. `watchNext` cards are the primary "continue watching" affordance — tapping one should go straight to marking the next episode watched or into the episode's detail, not through the series-detail screen first. `staleSeries` is a gentler "you left this a while ago" nudge section.
- **Known limitations**: `watchNext`/`staleSeries` have no `limit`/pagination on this combined endpoint — a user with hundreds of in-progress series gets them all in one response (180 `staleSeries` items in the current real dataset). Fine today; worth capping (or switching those two sections to "preview N, see full list via the dedicated endpoint") once library sizes grow. Also see the `userStatus` trustworthiness caveat above — not every card's status is enrichment-confirmed yet.

### `GET /me/recently-watched`

- **Purpose**: full watch history, paginated — what `/home`'s `recentlyWatched` section is a 10-item preview of.
- **Request params**: `limit` (optional, 1–50, default 10), `before` (optional, opaque cursor from a previous response's `nextCursor`).
- **Response**: `{ items: RecentlyWatchedItemDto[], nextCursor: string | null }`. Each item: `watchId`, `watchedAt`, `note`, `series` (summary), `episode` (summary).
- **Mobile UI usage**: an infinite-scroll history list/feed. This is a pure historical record — an episode watched on a since-dropped series still shows up here.
- **Known limitations**: none significant. Ordering is `watchedAt desc, id desc` — stable even when two watches share a timestamp.

### `GET /me/watch-next`

- **Purpose**: the same data as `/home`'s `watchNext` section, on its own — useful if the mobile app wants a dedicated "continue watching" screen without the rest of `/home`'s payload.
- **Request**: no params.
- **Response**: `WatchNextItemDto[]` — `series`, `nextEpisode`, `lastWatchedAt`, `userStatus` (always `WATCHING`).
- **Mobile UI usage**: same as `/home`'s `watchNext` section — a horizontal "continue watching" rail is the typical pattern.
- **Known limitations**: query is `userStatus = WATCHING AND nextEpisodeId IS NOT NULL` — exact, not a loose filter (see `docs/status-model-plan.md` §8). This depends on `nextEpisodeId` actually being populated; historically-imported series only got this backfilled in a one-time pass (`next-episode-backfill/`), not on an ongoing basis yet — a newly-enriched series' `nextEpisodeId` is set automatically by the TMDb-apply → backfill flow today, but there's no live trigger that re-runs the backfill as new episodes air for already-enriched shows. No pagination — same caveat as `/home`.

### `GET /me/stale-series`

- **Purpose**: in-progress series with no recent activity — "haven't watched in a while."
- **Request params**: `afterDays` (optional, 1–3650, default 30).
- **Response**: `StaleSeriesItemDto[]` — `series`, `lastWatchedAt`, `nextEpisode` (nullable), `userStatus` (`WATCHING` or `CAUGHT_UP` only).
- **Mobile UI usage**: a "pick up where you left off" section, sortable/filterable by how stale (`lastWatchedAt asc` is the default order — oldest activity first).
- **Known limitations**: `PAUSED` series are deliberately excluded (a user who explicitly paused already told the app they know — re-nudging is noise); this is called out in `docs/status-model-plan.md` §8 as a deliberate, revisitable choice, not a bug. No pagination.

### `GET /watchlist`

- **Purpose**: series the user wants to watch but hasn't started (or has since started, without being removed).
- **Request**: no params.
- **Response**: `WatchlistItemDto[]` — `id` (the `WatchlistItem` id, not the series id), `addedAt`, `series`, `userStatus` (may have moved on from `WATCHLIST` — see below).
- **Mobile UI usage**: a "want to watch" list, ordered most-recently-added first. If `userStatus` is no longer `WATCHLIST`, consider showing a small "already started" badge rather than hiding the item — it stays in this list until explicitly removed.
- **Known limitations**: intentionally does not merge into `UserSeriesProgress` filtering — a series moved from `WATCHLIST` to `WATCHING` still appears here (by design, see `WatchlistService.list`); removing it from this list is a separate `DELETE /series/:seriesId/watchlist` call. No pagination — fine at today's scale (max a few hundred items per user), worth revisiting if libraries grow much larger.

### `GET /series`

- **Purpose**: the mobile library/browse screen — every series the current user has any relationship with, filterable and searchable.
- **Request params**: `status` (optional, `UserSeriesStatus` enum — filter to series at exactly this personal status), `releaseStatus` (optional, `ReleaseStatus` enum), `q` (optional, case-insensitive title substring search, max 200 chars), `limit` (optional, 1–50, default 20), `cursor` (optional, opaque, from a previous response's `nextCursor`).
- **Response**: `{ items: SeriesCardDto[], nextCursor: string | null }`. Each card: `id`, `title`, `overview`, `posterUrl`, `backdropUrl`, `releaseStatus`, `userStatus`.
- **Mobile UI usage**: a grid or list library screen, with `status`/`releaseStatus` as filter chips (e.g. "Watching", "Caught Up", "Dropped") and `q` wired to a search bar. This is scoped to **the user's own library**, not a global catalog — there's no way to discover/add a series MyTv doesn't already know about yet (see limitations).
- **Known limitations**: this is a "my library" view, not a "search all of TMDb and add a new series" flow — that endpoint doesn't exist (see the project-wide gap below). Sort order is fixed (`title asc`) — no `sort=` param yet if the mobile app wants "recently added" or "recently watched" ordering for the library screen specifically.

### `GET /series/:id`

- **Purpose**: full series-detail screen in one call — metadata, this user's status, next episode, and every season/episode with per-episode watch state.
- **Request params**: `seriesId` (path).
- **Response**: `SeriesDetailDto` — `id`, `title`, `overview`, `posterUrl`, `backdropUrl`, `releaseStatus`, `userStatus`, `nextEpisode` (nullable summary), `seasons` (array of `{ seasonNumber, title, episodes[] }`, episodes ordered within each season), `externalIds` (nullable — `tmdbId`/`traktId`/`imdbId`, null if no enrichment match yet). Each episode in `seasons[].episodes[]` carries the base episode fields plus `watched` (boolean), `watchedAt` (nullable), `note` (nullable).
- **Mobile UI usage**: hero header from `backdropUrl`/`title`/`overview`/`releaseStatus`, a "watch next" call-to-action from `nextEpisode`, then a season-by-season episode list (checkmark or watched-state styling per episode from `watched`/`watchedAt`, note icon if `note` is non-null).
- **Known limitations**: `externalIds.imdbId` is currently always `null` — TMDb's response includes it, but the enrichment apply step doesn't write it to this column yet (a real, known gap, not intentionally withheld). `traktId` is always `null` — no Trakt apply step exists. No episode-level actions beyond what `POST /episodes/:episodeId/watch` already provides (no "mark whole season watched," no per-episode note editing from this response — notes are edited via `PATCH /episode-watches/:watchId/note`, which needs a `watchId` this endpoint doesn't currently expose per-episode — see project-wide gap below).

### `POST /episodes/:episodeId/watch`

- **Purpose**: mark an episode watched. The core interaction of the app.
- **Request params**: `episodeId` (path). No body.
- **Response**: `MarkWatchedResponseDto` — `watch` (the `EpisodeWatch` record), `series`, `nextEpisode` (nullable), `seriesCompleted` (boolean), `userStatus`. See "The swipe-to-watch flow" above for the full interaction contract.
- **Mobile UI usage**: the swipe-card / "mark watched" button handler. Idempotent — safe to retry on network failure.
- **Known limitations**: no "unmark watched" / undo endpoint yet — a mis-tap can't be reversed via the API today.

### `PATCH /episode-watches/:watchId/note`

- **Purpose**: add or replace the note on a specific watched episode.
- **Request params**: `watchId` (path, the `EpisodeWatch` id — not the episode id). **Body**: `{ text: string }` (1–2000 chars).
- **Response**: `EpisodeWatchDto` — `id`, `watchedAt`, `note`, `episode`.
- **Mobile UI usage**: a note/journal field on a watched-episode's detail view or the recently-watched feed.
- **Known limitations**: requires the `EpisodeWatch` id, which the client must have gotten from a prior response (`POST /episodes/:id/watch`'s `watch.id`, or `GET /me/recently-watched`'s `watchId`) — `GET /series/:id`'s per-episode watch state does not currently include this id, so a client can't jump straight from the series-detail screen to editing a note without going through recently-watched first (the same gap noted under `GET /series/:id` above). No delete-note endpoint — clearing a note requires sending an update (not currently supported, since `text` must be non-empty).

## Not available yet

- **Search / add a new series from TMDb.** `GET /series` only returns series MyTv already has a relationship with — there's no "search TMDb and start tracking a new show" endpoint. TMDb matching exists as an offline backend pipeline (`tmdb-enrichment/`), not a live API a client can call.
- **Movies** — series only in V1.
- **Real auth / multi-user support.**
- **Manual status changes** (pause/drop/resume) — `userStatus` only ever changes as a side effect of watching an episode or watchlist add/remove; there's no direct "set status to PAUSED" endpoint yet.
- **Undo / unmark watched.**
- **`EpisodeWatch.id` on `GET /series/:id`'s per-episode watch state** — blocks a direct "edit note from series detail" flow (see above).
- **`ExternalIds.imdbId`/`traktId`** — fetched by TMDb enrichment in `imdbId`'s case, but not yet written to the database; Trakt enrichment has no apply step at all.
