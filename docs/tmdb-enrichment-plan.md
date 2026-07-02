# TMDb Enrichment Plan

Planning document for enriching TV Time-imported `Series`/`Season`/`Episode` rows with metadata from TMDb (The Movie Database), as a **parallel** track alongside `docs/trakt-enrichment-plan.md` — not a replacement for it. This exists because Trakt application creation (`trakt.tv/oauth/applications/new`) is currently broken for the account trying to register one, so Trakt enrichment is blocked on something outside this codebase. **The existing Trakt dry-run pipeline (`trakt-enrichment/`) is untouched by this document** — no code was removed, modified, or written for this pass, `prisma/schema.prisma` was not touched, and no live TMDb API calls were made. Every TMDb-specific fact below came from reading `developer.themoviedb.org`'s public documentation, not from calling `api.themoviedb.org`.

This document mirrors `docs/trakt-enrichment-plan.md`'s structure and safety principles deliberately, so the two are easy to compare side by side and a future implementation pass can treat them as two instances of the same shape rather than two different designs.

## 1. What we're enriching (same dataset, not re-derived)

Same current-state numbers as the Trakt plan (re-verified against the DB, unchanged since that pass): 433 `Series`, 1,075 `Season`, 18,943 `Episode` rows, 0 imported episodes with a title, dataset skews heavily toward long-running anime (One Piece at 1,157 episodes, Naruto Shippuden, Bleach, Gintama, Fairy Tail, Boruto, Dragon Ball Z among the largest). `Series.rawMetadata.tvtimeShowId` is now backfilled on 390/433 series (completed in an earlier session) — not load-bearing for TMDb matching either, same as it wasn't for Trakt, since matching is title/year-based, not TV-Time-id-based. `ExternalIds` has 0 rows — nothing has been enriched by anything yet.

The anime-heavy, high-episode-count profile matters more for TMDb than it did for Trakt — see §5's discussion of TMDb's `append_to_response` season cap.

## 2. TMDb API facts this plan relies on

Pulled from `developer.themoviedb.org` between this and prior sessions — not from calling the live API.

**Authentication** — same shape as Trakt: a static credential, no OAuth/user login for public read endpoints. TMDb supports two forms: a legacy `api_key` query parameter, or an `Authorization: Bearer <read access token>` header (TMDb's documented "default"/preferred method). Either is sufficient for `/search/tv`, `/tv/{id}`, `/tv/{id}/season/{n}` — no account/session step required. *(Source: [Application-Level Authentication](https://developer.themoviedb.org/docs/authentication-application), [Getting Started](https://developer.themoviedb.org/docs/getting-started))*

**Rate limits** — meaningfully different from Trakt, and less precisely documented. TMDb's own docs say only that limits "sit somewhere in the 40 requests per second range" and can change at any time; community reports from TMDb staff mention up to ~50 req/s with ~20 connections per IP. **No `Retry-After` header is documented** on 429 responses (unlike Trakt, which explicitly provides one) — TMDb's guidance is just "respect the 429 if you receive one," with no server-provided wait time to honor. This changes the backoff design (§5): a fixed/exponential backoff is the only option, there's nothing to read off the response. Also notable: TMDb states limiting is enforced **by IP, not by API key** — worth knowing if this ever runs from a shared IP alongside other TMDb-calling processes. *(Source: [Rate Limiting](https://developer.themoviedb.org/docs/rate-limiting))*

**Search — server-side year filtering, unlike Trakt.** `GET /search/tv?query=...&first_air_date_year=...&page=...` — `first_air_date_year` filters results to that year **server-side**. This is a real, concrete improvement over Trakt's `/search/show`, which has no year parameter at all and requires every candidate to be fetched and scored client-side before year can narrow anything down. For the ~15+ series in this dataset with a `(YYYY)` suffix already in the title, TMDb search can use that year hint to shrink the candidate set at the API level, not just at the scoring level. Result objects: `id` (TMDb's numeric id), **`name`** (TMDb uses `name` for TV objects, not `title` — `title` is the movie-object field name; this plan is careful about the distinction since mixing them up would be a real bug, not a typo), `first_air_date` (a full `YYYY-MM-DD` string, not a bare year integer like Trakt's `year` — needs parsing), `overview`, `poster_path`, `popularity`. *(Source: [Search TV Shows reference](https://developer.themoviedb.org/reference/search-tv))*

**No explicit relevance score.** Trakt's search returns a `score` per result; TMDb's does not — results come back pre-sorted by TMDb's internal relevance ranking, but the score itself isn't exposed. `popularity` is a *different* signal (general show popularity, not query-match quality) and using it as a relevance proxy risks favoring a popular-but-wrong show over an obscure-but-correct one — a real concern given how niche some of this dataset's anime titles are. §3.2 proposes using **result rank/position** (TMDb's own ordering) as the relevance signal instead of `popularity`, which is an honest adaptation, not an equivalent substitute — flagged clearly, not glossed over.

**TV details** — `GET /tv/{id}?append_to_response=external_ids` returns `id`, `name`, `overview`, `poster_path`, `backdrop_path`, `first_air_date`, `status`, `number_of_seasons`, `number_of_episodes`, `genres`, `networks`, plus (via the appended namespace, in the *same* call) `external_ids.imdb_id`/`external_ids.tvdb_id` — useful for cross-referencing against whatever a future Trakt pass finds, without a second request. `status` has confirmed enum values (community-sourced, not from the official schema page directly, so treat as high-confidence but not 100% primary-source): `Returning Series`, `Planned`, `In Production`, `Ended`, `Cancelled`, `Pilot` — a real, usable mapping to MyTv's `SeriesStatus` (`Ended`→`ENDED`, `Cancelled`→`CANCELED`, everything else→`ONGOING`) that the Trakt plan flagged as *unconfirmed* for Trakt's equivalent field. *(Source: [TV Series Details reference](https://developer.themoviedb.org/reference/tv-series-details), TMDb community forum threads on the `status` enum)*

**Seasons + episodes — one call per season, not one call for the whole show.** `GET /tv/{id}/season/{season_number}` returns one season's episodes (`episode_number`, `name`, `overview`, `air_date`, `still_path` per episode). Unlike Trakt's `extended=episodes` (one call returns *every* season's episodes), TMDb requires either N separate season calls, or batching via `append_to_response=season/1,season/2,...` on the main `/tv/{id}` call — **capped at 20 comma-separated items per call**. For a show with more than 20 seasons this means multiple batched calls; for the vast majority of shows (well under 20 seasons) it's one combined call alongside the show details themselves. This dataset's biggest shows by *episode* count (One Piece, Naruto Shippuden, etc.) are not necessarily 20+ *season* shows in TMDb's grouping — TMDb tends to group long-running anime into large seasons rather than TV-Time-style many-small-seasons — but this needs confirming per-show once live calls happen, not assumed. *(Source: [TV Season Details reference](https://developer.themoviedb.org/reference/tv-season-details), [Append To Response](https://developer.themoviedb.org/docs/append-to-response), TMDb forum threads confirming the 20-item cap and that full multi-season-with-full-episode-detail in one call is "not possible or planned")*

**Images — relative paths, need a base URL prefix.** TMDb returns `poster_path`/`backdrop_path`/`still_path` as relative paths (e.g. `/1E5baAaEse26fej7uHcjOgEE2t2.jpg`), not full URLs like Trakt. The full URL is `https://image.tmdb.org/t/p/{size}{path}` — the base is a stable, well-known static domain (TMDb's own docs recommend fetching `/configuration` once to get the current size options, but the base URL itself has been stable for years and is safe to treat as effectively static rather than re-fetched every run). Size strings like `w500`/`original` control resolution — TMDb offers more explicit size control than Trakt's documentation shows. Episode-level images (`still_path`) are directly relevant to the new `Episode.imageUrl` field added in the last schema pass. *(Source: [Image Basics](https://developer.themoviedb.org/docs/image-basics))*

## 3. Matching strategy

Same three-signal shape as the Trakt plan (§3.2 there), adapted for the two real API differences above (server-side year filter, no relevance score).

### 3.1 Candidate generation

1. **Extract a year hint from the title**, identical logic to the Trakt plan: `/^(.*?)\s*\((\d{4})\)$/` → `bareTitle` + `titleYear`.
2. **Call `GET /search/tv?query={bareTitle}`**, adding **`&first_air_date_year={titleYear}`** when a year hint exists — this is the one place TMDb's matching can do *less* client-side work than Trakt's: when TV Time already gave us a year, TMDb's own search does the narrowing instead of us filtering a broader candidate set afterward. When there's no year hint, this degrades to the same broad-search-then-score approach the Trakt plan uses.
3. Take the top N results (propose N=10, same as Trakt plan, for consistency).

### 3.2 Confidence scoring

Score every candidate 0–100, same weight split as the Trakt plan (title 50 / year 30 / relevance 20) for direct comparability between the two providers' outputs, with one adapted signal:

| Signal | Weight | How it's computed |
| --- | --- | --- |
| Title match | 50 | Identical logic to the Trakt plan, comparing `bareTitle` against the candidate's **`name`** field (not `title` — see §2's TMDb naming note): 50 exact (normalized), 30 substring, scaled by string similarity otherwise |
| Year match | 30 | Identical logic, comparing `titleYear` against `new Date(candidate.first_air_date).getFullYear()` (TMDb gives a full date, not a bare year — needs parsing first). Same scoring: 30 exact, 15 within ±1, 10 neutral if unknown, 0 if known and off by more than 1 |
| **TMDb relevance (rank-based, not score-based)** | 20 | **Adapted, not identical**, because TMDb exposes no per-result relevance score (§2). Uses the candidate's **position in the returned, TMDb-ordered result list** instead: `max(0, 20 - position * 2)` — the top result gets 20, second gets 18, ... down to 0 by the 11th. This reflects "how strongly did TMDb itself rank this above the alternatives," same intent as the Trakt formula, different input signal. Flagged here as a deliberate adaptation so it isn't mistaken for an equivalent, independently-validated metric — it's a reasonable proxy, not a proven one, until tested against real results. |

Same post-fetch sanity check as the Trakt plan (§3.2 there): once a season/episode fetch happens, compare MyTv's watched-episode count for that series against TMDb's total (`number_of_episodes`, or a sum over fetched seasons) — watching more episodes than TMDb says exist is impossible and downgrades an otherwise-confident match.

### 3.3 Confidence tiers → action

Identical thresholds and identical action shape to the Trakt plan, so the two providers' outputs are directly comparable without a separate mental model:

| Tier | Threshold | Action |
| --- | --- | --- |
| **Auto-apply** | Combined score ≥ 85, next candidate ≥ 15 points behind | Fetch show + season(s)/episodes, would write `ExternalIds.tmdbId` + enrichment fields (once a non-dry-run pass exists — not this one) |
| **Needs review** | Score 50–84, or ambiguous ≥ 85, or episode-count sanity check fails | Fetch and cache the top candidate for reviewer context; record an `ImportIssue`; no app-table write |
| **No match** | Score < 50 or zero results | No fetch; record an `ImportIssue` (`WARNING`) |

Reuses the same `ImportBatch`/`ImportRawRow`/`ImportIssue` bookkeeping the Trakt pipeline already established, with `ImportBatch.source: "tmdb-enrichment"` as the only thing distinguishing a TMDb run from a Trakt run (`"trakt-enrichment"`) or the TV Time importer (`"tvtime-export"`) — all three coexist in the same tables without conflict, since each is scoped by its own batch.

## 4. Enrichment workflow (proposed steps, not implemented)

1. **Candidate search** per un-enriched series (`ExternalIds` is null, or specifically `ExternalIds.tmdbId` is null once dual-provider rows exist — see §6) — 1 TMDb call per series, with server-side year filtering applied when possible (§3.1).
2. **Score candidates** (§3.2) — no API call.
3. **For auto-apply (and top needs-review) candidates**: fetch `GET /tv/{id}?append_to_response=external_ids,season/1,...,season/N` — bundling the show details, external ids, *and* up to 20 seasons' worth of episodes into as few calls as the 20-item cap allows (one call for shows with ≤20 seasons; batched calls beyond that, per §2's limitation).
4. **Match TMDb episodes to existing `Episode` rows** by `(seasonNumber, episodeNumber)` — same exact-join approach as the Trakt plan; TMDb's `season_number`/`episode_number` fields map directly to MyTv's own identity fields. New (unwatched) episodes get created with title/overview/airDate/imageUrl but no `EpisodeWatch`, same "full catalog without inventing watch history" principle as the Trakt plan.
5. **Write enrichment fields** following the identical non-clobbering rule as the Trakt plan (§4 step 6 there): fill-if-null only, never overwrite organic or more-authoritative data. If both TMDb and Trakt data exist for the same field (e.g. both found an `overview`), first-write-wins under fill-if-null — meaning whichever provider's enrichment pass runs *first* effectively becomes primary for that field, which is worth being deliberate about once both pipelines are live (see §6's provenance discussion for where that decision would be recorded).
6. **Cache every raw TMDb response** — see §5.
7. **Generate reports** — `tmdb-enrichment-report.json` / `tmdb-needs-review.json`, identical shape to the Trakt pipeline's `trakt-enrichment-report.json`/`trakt-needs-review.json` (same required fields: MyTv series id/title, chosen TMDb id/name/year, confidence score, reason breakdown, watched vs TMDb-total episode count), so a future combined dashboard/reviewer tool can treat both providers' output identically.

## 5. Rate limiting, backoff, and caching strategy

**Throttling.** TMDb's ~40–50 req/s ceiling is far more generous than Trakt's ~3.3 req/s average (1000 per 5 min) — a full 433-series run at even a conservative TMDb pace (propose ~10 req/s, still well under the documented range) would take roughly a minute or two of pure request time, versus the Trakt plan's estimated ~5 minutes at its proposed pace. Still propose staying well under the ceiling rather than approaching it, same reasoning as the Trakt plan: no user is waiting on a background job, headroom is free.

**429 handling — different from Trakt.** No `Retry-After` header is documented (§2), so there's no server-provided wait time to read. Falls back to the same exponential-backoff-with-jitter used for 5xx/network errors in the Trakt plan (base delay, doubling, capped, plus jitter) rather than Trakt's "sleep exactly what the server said" approach. Capped retry count, same as Trakt (propose 5), degrading to a logged `ImportIssue` rather than hanging.

**Other failures.** Same approach as the Trakt plan: exponential backoff with jitter for 5xx/network errors, capped retries, one bad show doesn't abort the run for the rest.

**Caching — same two-layer design as the Trakt plan, different synthetic source-file naming:**

1. **Permanent raw-response archive** in `ImportRawRow` under an `ImportBatch{source: "tmdb-enrichment"}` — `sourceFile` values like `tmdb:search:{normalizedQuery}`, `tmdb:show:{tmdbId}`, `tmdb:seasons:{tmdbId}:batch{n}` (the `batch{n}` suffix because, unlike Trakt's single seasons call, a TMDb show with >20 seasons produces multiple season-batch responses that each need their own cache row).
2. **Freshness-based skip for re-runs** — same proposed 30-day window as the Trakt plan, same reasoning (don't re-fetch a finished show's catalog; do re-fetch an ongoing show past the freshness window to pick up newly aired episodes).

## 6. Schema changes needed to support TMDb IDs alongside future Trakt IDs

**Short answer: none required at the column level — this was already anticipated.** `ExternalIds.tmdbId String? @unique` already exists (it predates this plan; it was part of the original schema design for exactly this kind of future provider support), and the `provider`/`providerId`/`matchConfidence`/`matchSource`/`matchedAt`/`rawMetadata` fields added in the schema pass before the Trakt dry-run work were deliberately provider-agnostic, not Trakt-specific. A TMDb match and a (future) Trakt match can both be written to the *same* `ExternalIds` row simultaneously — `traktId` and `tmdbId` are independent nullable columns, not mutually exclusive.

**One real design gap, found by actually trying to use these fields for two providers at once, not by inspection alone:** `provider`/`providerId`/`matchConfidence`/`matchSource`/`matchedAt` are **singular** per `ExternalIds` row — there's exactly one set of them, not one per provider. If a TMDb enrichment pass runs first and sets `provider: "tmdb"`, `matchConfidence: 92`, `matchedAt: <date>`, and a Trakt pass runs later against the same series, it would need to overwrite those same five fields with Trakt's values — at which point "how confident were we in the TMDb match" is no longer independently answerable from those columns alone (though it's still recoverable from `ImportRawRow`/`ImportIssue`, just indirectly).

Two ways to resolve this, neither requiring a schema change today:

- **(Recommended) Treat the five singular fields as "primary/most-recently-confirmed match" convenience fields, and store full per-provider detail inside `rawMetadata`** as a structured object, e.g. `{ tmdb: { confidence, matchedAt, source, candidatesConsidered }, trakt: { ... } }`. `rawMetadata` is already schemaless JSON specifically for this kind of thing — no migration needed, just a documented convention that should be written down before the first dual-provider write happens (propose doing this as part of whichever plan gets implemented first, Trakt or TMDb).
- **(Fallback, only if the above proves insufficient in practice)** Split into genuinely per-provider columns (`tmdbMatchConfidence`/`traktMatchConfidence`/etc., getting unwieldy fast) or a separate one-row-per-provider-per-series child table (e.g. `SeriesProviderMatch { seriesId, provider, providerId, matchConfidence, matchedAt, rawMetadata }`, unique on `(seriesId, provider)`). This is more correct for genuinely simultaneous multi-provider provenance tracking but is real added complexity that isn't justified unless the convention-based approach above turns out to be too lossy in practice.

This plan recommends starting with the JSON-convention approach and only reaching for the child-table fallback if it's actually needed — consistent with this project's general bias (seen throughout `docs/mytv-prisma-schema-plan.md`) toward not adding structure until a real, observed need justifies it.

**No other schema gaps found for TMDb specifically** — the four gaps the Trakt plan identified (`Series.backdropUrl`, `Season.rawMetadata`/`importBatchId`, `ExternalIds` provenance fields, `Episode.imageUrl`) were all already applied to the schema in the session between that plan and this one, and all of them are equally usable by a TMDb pass: `backdropUrl` ← TMDb's `backdrop_path`, `Episode.imageUrl` ← TMDb's `still_path`, `Season.rawMetadata`/`importBatchId` for TMDb's season-level data with nowhere else to go.

## 7. TMDb vs Trakt for MyTv's needs

Not "which one is better" in the abstract — which trade-offs matter for *this* dataset and *this* product.

| Dimension | Trakt | TMDb | Which matters more here |
| --- | --- | --- | --- |
| Auth complexity | Static key, no OAuth for reads | Static key/token, no OAuth for reads | Tie — both are equally easy to unblock once a credential exists |
| Server-side year filtering | None — client-side only | `first_air_date_year` param | **TMDb wins** — directly improves precision for the ~15+ series with a year hint already in the title |
| Full episode catalog in one call | Yes, any season count | Capped at 20 seasons per `append_to_response` call | **Trakt wins for this dataset specifically** — several of the largest shows here are long-running; needs confirming per-show whether TMDb's season *grouping* (vs raw episode count) keeps them under the cap |
| Explicit search relevance score | Yes (`score`) | No — rank-only, adapted scoring (§3.2) | **Trakt wins** — a real, exposed signal beats an inferred one |
| Image URLs | Full URLs, prefix `https://` only | Relative paths, need base + size | Roughly tied — TMDb requires one extra string-building step but offers more size control |
| Episode-level images | Present, less central to docs | `still_path`, well-documented, standard | Slight edge to TMDb for the new `Episode.imageUrl` field specifically |
| `status` enum confirmed | No (flagged as unconfirmed in the Trakt plan) | Yes (`Returning Series`/`Ended`/`Cancelled`/etc., community-sourced) | **TMDb wins**, though this may just reflect research depth, not a true gap in Trakt's docs |
| Rate limit ceiling | ~3.3 req/s average (1000/5min) | ~40–50 req/s | **TMDb wins** by a wide margin — meaningfully faster for a 433-series run |
| `Retry-After` on 429 | Documented, explicit | Not documented | **Trakt wins** — precise backoff beats guessing |
| Currently accessible | **Blocked** (app creation broken) | Available (assuming a key can be obtained normally) | **TMDb wins right now**, which is the actual reason this document exists |

**Recommendation:** these are complementary, not competing, and the right long-term design already supports both (§6). Given Trakt is blocked *today*, TMDb is the practical way to make progress now — and it's not a downgrade while doing so: server-side year filtering and a faster rate ceiling are genuine advantages for this specific dataset, not just "the backup option." Once Trakt access is restored, running both against the same series and comparing their independently-computed confidence scores would itself be a useful cross-validation signal (two providers agreeing on the same match is stronger evidence than either alone) — but that's a future enhancement, not a requirement to unblock enrichment now.

## 8. Risks / open questions

- **TMDb's season-grouping for long-running anime is unconfirmed.** Whether shows like One Piece or Naruto Shippuden stay under the 20-season `append_to_response` cap in TMDb's own catalog (as opposed to TV Time's per-arc season splitting) needs checking against real data, not assumed either way.
- **Rank-based relevance scoring (§3.2) is an untested proxy.** It's a reasonable adaptation, not a validated one — should be checked against real search results once live calls are possible, and the weighting revisited if it turns out to correlate poorly with actual match quality.
- **`status` enum values are community-sourced, not pulled from TMDb's primary OpenAPI schema directly** — worth a final check against one real response before writing the mapping.
- **Rate limit numbers are explicitly called "can change at any time" by TMDb itself** — re-confirm at implementation time, same caveat as the Trakt plan.
- **First-write-wins field ownership (§4 step 5)** if both providers ever run against the same series needs a real decision (which provider is "primary" for conflicting fields) before both pipelines go live simultaneously — flagged, not resolved, here.

## 9. Explicitly not done in this pass

- No importer/enrichment code written — `trakt-enrichment/` is completely untouched.
- No `prisma/schema.prisma` changes — §6 concludes none are needed at the column level, and documents a convention (not a migration) for the one provenance gap found.
- No live calls to `api.themoviedb.org` — all TMDb facts above came from reading `developer.themoviedb.org` documentation pages and community forum threads, which required no API key.
- No TMDb application/API key was created or used.
