# API Contract — for the React Native client

This is a narrative summary of the backend API for whoever builds the mobile app. The full, always-up-to-date spec is served from the running backend at **`/docs`** (Swagger UI) and **`/docs-json`** (raw OpenAPI JSON) — treat this file as an orientation guide, not the source of truth.

Base URL (local dev): `http://localhost:3000`

## Auth (current state)

There is no login yet. Every request is treated as the same hardcoded dev user. Don't build a login screen against this backend yet — just call the endpoints directly. When real auth lands, the only client-side change should be adding an `Authorization` header.

## Data model the client should know about

- **Series** — a show. Has its own `releaseStatus`: `UNKNOWN` / `RETURNING` / `ENDED` / `CANCELLED` / `IN_PRODUCTION` — the show's *public* broadcast status, provider-derived (TMDb/Trakt) and never affected by what any user has watched. `UNKNOWN` until an enrichment pass confirms it (most series are `UNKNOWN` today — enrichment isn't wired up yet).
- **Season / Episode** — standard hierarchy. Episodes are identified by `id`, but also carry `seasonNumber` + `episodeNumber` for display.
- **A user's personal status on a series** is `userStatus`, separate from the series' own `releaseStatus`: `UNKNOWN` / `WATCHLIST` / `WATCHING` / `PAUSED` / `DROPPED` / `CAUGHT_UP` / `COMPLETED`. `WATCHLIST`/`PAUSED`/`DROPPED` are user-controlled; `WATCHING`/`CAUGHT_UP`/`COMPLETED` are computed. The distinction that matters most: `CAUGHT_UP` means "watched everything that exists so far, but the show is still airing — more may come," while `COMPLETED` means "watched everything, and the show itself is confirmed over." A fresh watch always resets `userStatus` to `WATCHING` (or `CAUGHT_UP`/`COMPLETED` if that was the last known episode) regardless of what it was before — so watching an episode is always enough to "resume" a `PAUSED`/`DROPPED` series without a separate action.
  - **Client note on trusting `WATCHING`:** for series imported from a TV Time export, `WATCHING` is currently a *placeholder*, not a confirmed "actively watching" signal — the importer only knows "some episodes were watched, and the show isn't archived," not the show's full episode list. Don't build UI copy that treats `WATCHING` as more certain than that (e.g. don't say "you're actively watching this" as a confident claim) until the backend has actually run metadata enrichment for that series. `CAUGHT_UP` and `COMPLETED` in particular are **never** set from TV Time data alone — they only appear once a TMDb/Trakt enrichment pass has resolved a series' full episode catalog and release status, which hasn't happened for any series yet (enrichment is dry-run only, see "Not available yet" below). Right now, seeing `WATCHING` on an imported series is normal and doesn't imply anything more than "not dropped, has some watch history."
- **"Haven't watched for a while" is not a status value anywhere in the API.** It's `GET /home`'s `staleSeries` section — a filter MyTv computes fresh on every call (`userStatus` is `WATCHING` or `CAUGHT_UP`, and `lastWatchedAt` is older than the threshold), not a `userStatus` a series can be "in." Don't look for a `STALE` enum value; there isn't one and won't be — if a series needs to be flagged as stale in some other part of the UI later, recompute the same filter, don't expect the backend to hand back a stored flag.
- **EpisodeWatch** — one record per watched episode, optionally with a note attached.

## Home screen — `GET /home`

One call, three sections:

- `recentlyWatched`: up to 10 most-recently-watched episodes, newest first. If the UI needs to page further back, switch to `GET /me/recently-watched`.
- `watchNext`: one entry per series currently being watched, each with its cached next episode.
- `staleSeries`: in-progress series with no activity in the last 30 days.

Each item embeds full `series` and `episode`/`nextEpisode` objects — no follow-up requests needed to render a card (poster, title, episode number, overview).

## The swipe-to-watch flow (episode cards)

This is the interaction the response shapes are optimized for:

1. User swipes an episode card right.
2. Client immediately shows a loading state on that card and calls `POST /episodes/:episodeId/watch`.
3. **On success**: the response includes `nextEpisode` (or `null`) for the *same series*. The client replaces the swiped card's content with `nextEpisode` in place — no extra fetch, no layout jump. If `nextEpisode` is `null`, `seriesCompleted` is `true` and the client should remove the card; check the response's `userStatus` to tell a `CAUGHT_UP` show ("nothing to watch *yet*") apart from a genuinely `COMPLETED` one ("nothing more is coming") if the UI wants to say something different for each.
4. **On failure**: the client animates the card back to its original position. Retrying is safe — marking watched is idempotent, so a retried call after a network failure won't create a duplicate watch or double-advance the series.

This same shape is what powers `watchNext` on the home screen, so a "next episode" card always looks the same whether it came from `/home` or from a fresh `/episodes/:id/watch` call.

## Pagination (`GET /me/recently-watched`)

Cursor-based, opaque cursor:

```
GET /me/recently-watched?limit=10
-> { items: [...], nextCursor: "abc123..." }

GET /me/recently-watched?limit=10&before=abc123...
-> next (older) page
```

`nextCursor` is `null` when there are no more items. Don't parse or construct cursor values on the client — treat them as opaque strings round-tripped from the server.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/home` | Home screen: recently watched, watch next, stale series |
| GET | `/me/recently-watched?limit=&before=` | Paginated watch history |
| GET | `/me/watch-next` | Series in progress + their next episode |
| GET | `/me/stale-series?afterDays=` | In-progress series with no recent activity |
| GET | `/watchlist` | Series the user wants to watch |
| POST | `/series/:seriesId/watchlist` | Add a series to the watchlist (idempotent) |
| DELETE | `/series/:seriesId/watchlist` | Remove a series from the watchlist (404 if absent) |
| POST | `/episodes/:episodeId/watch` | Mark an episode watched; returns next episode / completion |
| PATCH | `/episode-watches/:watchId/note` | Add or replace a note on a watched episode |

Full request/response schemas, including field-level descriptions and examples, are in Swagger at `/docs`.

## Error shape

Standard Nest validation/HTTP-exception format:

```json
{ "statusCode": 400, "message": ["limit must not be greater than 50"], "error": "Bad Request" }
```

or for a single message:

```json
{ "statusCode": 404, "message": "Episode <id> not found", "error": "Not Found" }
```

## Not available yet

- Search / add series from an external source (Trakt) — series currently only exist via seed data or (later) direct creation.
- Movies — series only in V1.
- Real auth / multi-user support.
