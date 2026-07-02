# API Contract — for the React Native client

This is a narrative summary of the backend API for whoever builds the mobile app. The full, always-up-to-date spec is served from the running backend at **`/docs`** (Swagger UI) and **`/docs-json`** (raw OpenAPI JSON) — treat this file as an orientation guide, not the source of truth.

Base URL (local dev): `http://localhost:3000`

## Auth (current state)

There is no login yet. Every request is treated as the same hardcoded dev user. Don't build a login screen against this backend yet — just call the endpoints directly. When real auth lands, the only client-side change should be adding an `Authorization` header.

## Data model the client should know about

- **Series** — a show. Has its own `status`: `ONGOING` / `ENDED` / `CANCELED` (whether the show itself is still airing).
- **Season / Episode** — standard hierarchy. Episodes are identified by `id`, but also carry `seasonNumber` + `episodeNumber` for display.
- **A user's progress on a series** is `WATCHING` or `COMPLETED` — separate from the series' own status. `COMPLETED` means the user has watched every episode that exists right now; if the show airs more episodes later, a fresh `nextEpisode` will appear the next time the user marks something watched on it (or once metadata syncs, in a later version).
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
3. **On success**: the response includes `nextEpisode` (or `null`) for the *same series*. The client replaces the swiped card's content with `nextEpisode` in place — no extra fetch, no layout jump. If `nextEpisode` is `null`, `seriesCompleted` is `true` and the client should remove the card (or show a "completed" state) instead.
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
