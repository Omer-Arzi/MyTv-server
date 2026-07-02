# Trakt Enrichment Plan

Planning document for enriching TV Time-imported `Series`/`Season`/`Episode` rows with real metadata from Trakt: series Trakt ID, episode titles, air dates, overviews, poster/backdrop URLs, and — where possible — the full episode catalog (not just the episodes the user happened to watch). **No code was written for this pass, `prisma/schema.prisma` was not touched, and no live Trakt API calls were made** — every Trakt-specific fact below was pulled from Trakt's public documentation (`docs.trakt.tv`), not from calling `api.trakt.tv`. Sources are linked at the bottom of each section that relies on them.

## 1. What we're enriching (current state, not assumed)

Queried directly against the local dev DB (post TV Time import):

| | |
| --- | --- |
| `Series` rows | 433 |
| `Season` rows | 1,075 |
| `Episode` rows | 18,943 |
| Episodes with a non-null `title` | 30 (all from seed data — **0 imported episodes have a title**, confirming `docs/tvtime-data-audit.md` §5) |
| Episodes with `runtimeMinutes` populated | 7,975 (from TV Time's per-watch-event `runtime` field) |
| Duplicate series titles (case/whitespace-normalized) | 0 |
| Series with a `(YYYY)` year suffix already in the title | ~15+ observed (e.g. `Doctor Who (2005)` vs `Doctor Who (2023)`, `INVINCIBLE (2021)`, `Alice in Borderland (2020)`) |

Two concrete findings that shape this plan:

1. **TV Time itself already disambiguates some naming collisions** by appending a year to the title (`Doctor Who (2005)` vs `Doctor Who (2023)`). This is a gift for matching — when present, it's a strong, free signal — but it's inconsistent (most titles don't have it), so the matching strategy can't depend on it being there.
2. **The dataset skews heavily toward long-running anime**: the 10 largest imported series by episode count are One Piece (1,157 episodes), Naruto Shippuden (506), Family Guy (409), Bleach (406), Gintama (368), Fairy Tail (328), Bob's Burgers (314), Boruto (293), Dragon Ball Z (291), The Big Bang Theory (280). Anime is exactly the content type where absolute-vs-season episode numbering mismatches between metadata providers are most common — flagged as a specific risk in §7, not a hypothetical one.

**Prerequisite fix found during this planning pass, not yet applied:** `Series.rawMetadata` is currently empty (`{}`) for all 430 imported series — the TV Time importer's `findOrCreateSeries` never actually wrote `tvtimeShowId` into it, even though `Episode.rawMetadata.tvtimeShowId` **is** correctly populated on all 18,913 imported episodes. This isn't a blocker (the enrichment matcher works from `Series.title`, not TV Time's internal id), but it should be backfilled — trivially, by copying `tvtimeShowId` up from any one of a series' episodes — before or alongside the enrichment work, so `Series.rawMetadata` is actually useful for cross-referencing later. Recorded here so it isn't lost; not implemented in this pass.

## 2. Trakt API facts this plan relies on

Pulled from `docs.trakt.tv` (their public docs site, which itself has an AI-agent-oriented `/llms.txt` index) between this and the previous session — not from calling the live API.

**Authentication** — public read (GET) endpoints need only a `trakt-api-key` header (your app's `client_id`) plus `trakt-api-version: 2` and a `User-Agent`. OAuth is **not** required for `/search`, `/shows/:id`, `/shows/:id/seasons`, etc. — those are unauthenticated-capable endpoints. This matters because it means enrichment can run as a pure server-side background job with a static API key, no per-user OAuth flow. *(Source: [Required Headers](https://docs.trakt.tv/docs/required-headers.md))*

**Rate limits** — GET requests (authenticated or not) are limited to **1000 calls per 5 minutes**, per the calling application. Exceeding it returns HTTP `429` with a `Retry-After` header (seconds to wait) and an optional `X-Ratelimit` JSON debug header. *(Source: [Rate Limiting](https://docs.trakt.tv/docs/rate-limiting.md))*

**Search** — `GET /search/{type}?query=...` (e.g. `/search/show`) does free-text search and returns `{ score, type, show: { title, year, ids: { trakt, slug, tvdb, imdb, tmdb } } }[]`, ordered by Trakt's own relevance `score`. There is **no server-side year filter** — `year` only comes back on each result, so year-based narrowing has to happen client-side after the search call, not as a query param. A separate `/search/show/exact?query=...` endpoint exists, described as "best for title-first results." *(Source: [Search](https://docs.trakt.tv/docs/search.md), [getsearchquery reference](https://docs.trakt.tv/reference/getsearchquery.md))*

**Show summary** — `GET /shows/{id}` where `{id}` accepts a Trakt numeric id or slug (from the search result's `ids`). `?extended=full` adds `overview`, `status`, and an `images` object (only present when `extended=full`/`images` is requested).

**Seasons + full episode catalog in one call** — `GET /shows/{id}/seasons?extended=full,episodes` returns every season **with every episode nested inside it**, including per-episode `title`, `overview`, `first_aired`, `ids`, and images when `full` is combined in. This is the key endpoint for "full episode catalog when possible" — it's one HTTP call per show, not one call per season. Trakt's own docs warn this "returns a lot of data, so please only use this extended parameter if you actually need it" — noted for the caching strategy in §5. *(Source: [getshowsseasons reference](https://docs.trakt.tv/reference/getshowsseasons.md))*

**Images** — Trakt hosts image URLs directly (not just external ids to fetch from elsewhere). `images` objects contain `poster`, `fanart` (this is the "backdrop" equivalent), `banner`, `logo`, `clearart`, `thumb` arrays; paths come back without a scheme and need `https://` prepended. `ids` also includes `tmdb`/`imdb`/`tvdb`, so a TMDB image fallback is possible later if Trakt's own images are ever missing for a title, but is out of scope for this plan. *(Source: [Images](https://docs.trakt.tv/docs/images.md))*

**Not independently verified in this session** (recalled as standard Trakt behavior, not confirmed against a live sample response — flag before implementing): the exact string values of a show's `status` field (expected to be something like `returning series` / `ended` / `canceled` / `upcoming`, needing a mapping table to MyTv's `SeriesStatus` enum). This should be confirmed against one real `GET /shows/{id}?extended=full` response before writing the mapping, not guessed.

## 3. Matching strategy

### 3.1 Candidate generation

For each `Series` row without an `ExternalIds.traktId` yet:

1. **Extract a year hint from the title if present.** If the title matches `/^(.*?)\s*\((\d{4})\)$/`, split into `bareTitle` + `titleYear` (e.g. `"Doctor Who (2005)"` → `bareTitle="Doctor Who"`, `titleYear=2005`). Otherwise `bareTitle` is the title as-is and `titleYear` is unknown.
2. **Call `GET /search/show?query={bareTitle}`** (general search, not `/exact`) — broader recall matters more than precision at the candidate stage, since scoring happens next. Take the top N results (propose N=10).
3. If `titleYear` was extracted, **prefer** (but don't require) candidates whose `show.year` matches it — TV Time's year suffix is usually the show's premiere year, and Trakt's `year` field is also premiere year, so an exact match is a strong signal; a close match (±1) is still meaningful since premiere-year conventions occasionally differ by region/provider.

### 3.2 Confidence scoring

Score every candidate 0–100, combining three independent signals — deliberately not just trusting Trakt's own `score` alone, since that's a generic text-relevance score with no knowledge of *our* data (year hints, episode counts):

| Signal | Weight | How it's computed |
| --- | --- | --- |
| Title match | 50 | 50 if `bareTitle` case/whitespace-normalized equals candidate `show.title` exactly; 30 if one is a substring of the other after normalization; scaled down further by a string-similarity ratio otherwise (e.g. Levenshtein-based) |
| Year match | 30 | 30 if `titleYear` is known and equals `show.year` exactly; 15 if within ±1; 10 (neutral, not penalized) if `titleYear` is unknown — the *absence* of a year hint shouldn't count against a candidate, since most TV Time titles never had one to begin with; 0 if `titleYear` is known and the candidate's year is off by more than 1 |
| Trakt relevance | 20 | Trakt's own `score`, normalized to 0–20 relative to the top result in that search's result set (so it reflects "how much better is this than the alternatives," not an absolute scale) |

**After a candidate is tentatively selected**, one more check happens once the seasons/episodes are actually fetched (§4 step 3), not before: compare the *number of episodes MyTv already has recorded as watched* for that series against Trakt's `aired_episodes`/total episode count. A large mismatch (e.g. MyTv has more watched episodes than Trakt says exist at all) is a strong signal the match is wrong, and downgrades confidence retroactively even after a high pre-fetch score — this mirrors the `ep_watch_count` cross-check the TV Time importer already does (`docs/tvtime-data-audit.md` §7.4), applied one layer further out.

### 3.3 Confidence tiers → action

| Tier | Threshold | Action |
| --- | --- | --- |
| **Auto-apply** | Combined score ≥ 85 **and** exactly one candidate scores within 15 points of the top candidate (i.e. it's not a close call) | Fetch full show + seasons/episodes, write `ExternalIds` + enrichment fields automatically |
| **Needs review** | Score 50–84, or ≥ 85 but with a second candidate close behind (ambiguous), or the post-fetch episode-count sanity check fails | Fetch and cache the top candidate's data (so a human reviewer isn't starting from zero), but do **not** write it into `Series`/`Episode` — record an `ImportIssue` with the candidate, its score, and why it wasn't auto-applied |
| **No match** | Best candidate scores < 50, or search returned zero results | Leave `ExternalIds` unset, record an `ImportIssue` (`WARNING`) noting no confident candidate was found; series stays enrichable in a future run (e.g. once a corrected title is manually set) |

This reuses the exact bookkeeping model already built for the TV Time importer rather than inventing a parallel mechanism: an enrichment run creates its own `ImportBatch` (`source: "trakt-enrichment"`), and every fetched-but-not-applied or fetch-failed candidate becomes an `ImportIssue` row tied to that batch, `relatedEntityType: "Series"`, `relatedEntityId: <series id>` — the same shape `needs-review.json` for the TV Time importer already knows how to render, so no new reporting format is needed, only a new batch `source` value to distinguish enrichment runs from TV Time import runs.

## 4. Enrichment workflow (proposed steps, not implemented)

1. **Backfill** `Series.rawMetadata.tvtimeShowId` from any one episode's `rawMetadata.tvtimeShowId` for that series (the gap noted in §1) — cheap, one-time, no API calls.
2. **Candidate search** per un-enriched series (§3.1) — 1 Trakt call per series.
3. **Score candidates** (§3.2) — no API call, pure computation over the cached search response.
4. **For auto-apply candidates only**: fetch `GET /shows/{id}?extended=full` (1 call) and `GET /shows/{id}/seasons?extended=full,episodes` (1 call) — so 3 Trakt calls total per auto-applied series (search + show + seasons).
5. **Match Trakt episodes to existing `Episode` rows** by `(seasonNumber, episodeNumber)` — this is already MyTv's own unique key (`@@unique([seasonId, episodeNumber])`), so the join is exact, not fuzzy. Episodes Trakt has that MyTv doesn't (because the user hasn't watched them) get **created** with title/overview/airDate but deliberately **no** `EpisodeWatch` — this is what "full episode catalog" means: MyTv now knows the show has 12 episodes even though the user only watched 8, without inventing watch history.
6. **Write enrichment fields**, following the same non-clobbering rule the TV Time importer already uses for organic data: only overwrite a field if it's currently `null`, or if it was itself last written by an earlier *enrichment* batch (never overwrite a value a human or a different, more-authoritative process set). Concretely: `Episode.title`/`overview`/`airDate` fill only if currently null; `Series.overview`/`posterUrl`/`status` fill only if currently null or default; `ExternalIds` is enrichment-owned outright (nothing else writes it).
7. **Cache every raw Trakt response** (search, show, seasons) — see §5.
8. **Generate reports** mirroring the TV Time importer's shape: `trakt-enrichment-report.json` (counts: auto-applied, needs-review, no-match, episodes created vs updated, Trakt calls made), plus entries feeding the same `needs-review.json` pattern.

## 5. Rate limiting, backoff, and caching strategy

**Throttling.** With 433 series needing ~3 calls each in the best case (search + show + seasons), a full first-time enrichment run is roughly 1,300 calls — well inside a single 1000-per-5-minutes bucket if paced, or two windows if not. Propose a conservative client-side pace **well under** the documented limit (e.g. a fixed delay targeting ~4–5 requests/second, ~250 req/min) rather than bursting close to 1000/5min — the limit is shared across however many other things might call the same Trakt app credentials, and headroom costs nothing on a background job with no user waiting on it.

**429 handling.** On a `429`, read `Retry-After` and sleep exactly that long before retrying (don't guess a backoff value when the server told us the exact number). Cap retries per request (e.g. 5) so a persistent problem surfaces as an `ImportIssue` (`ERROR`) instead of hanging the run forever.

**Other failures.** Network errors and 5xx responses get exponential backoff with jitter (e.g. 1s, 2s, 4s, 8s, capped, plus random jitter to avoid thundering-herd if this is ever run concurrently), also capped at a small max-retry count, also degrading to a logged `ImportIssue` rather than crashing the whole run — one bad show shouldn't abort enrichment for the other 432.

**Caching — two layers:**

1. **Permanent raw-response archive**, reusing the exact `ImportRawRow` pattern already built for TV Time (`docs/mytv-prisma-schema-plan.md` §6) rather than inventing a new cache table: each Trakt HTTP response (search result set, show detail, seasons+episodes) gets one `ImportRawRow` under the enrichment `ImportBatch`, with a synthetic `sourceFile` like `trakt:search`, `trakt:show:{traktId}`, `trakt:seasons:{traktId}` and `sourceRowNumber` as a sequence within that synthetic file. This gives enrichment the same audit trail property the TV Time import has — "what did Trakt actually say, verbatim, at the time we matched this" — without a schema change.
2. **Freshness-based skip for re-runs**: before calling Trakt for a series that already has a `traktId` in `ExternalIds`, check whether a cached response exists from within a freshness window (propose 30 days) — if so, skip the API call entirely and reuse the cached seasons/episodes data (useful for re-running the episode-matching/creation step alone, e.g. after fixing a bug in step 5, without re-hitting Trakt for shows already resolved). Past the freshness window, re-fetch to pick up newly aired episodes or corrected metadata for ongoing shows specifically (`Series.status` not `ENDED`/`CANCELED`) — finished shows don't need re-fetching at all once enriched, since their catalog won't change.

## 6. Schema fields to update, and schema changes needed

**Fields enrichment would write into the *existing* schema, no changes needed:**

| Model.field | Written from |
| --- | --- |
| `ExternalIds.traktId` | `show.ids.trakt` |
| `ExternalIds.tmdbId` | `show.ids.tmdb` (bonus — same `ids` object, no extra call) |
| `ExternalIds.imdbId` | `show.ids.imdb` (bonus) |
| `Series.overview` | `show.overview` (fill-if-null) |
| `Series.posterUrl` | `show.images.poster[0]` (fill-if-null) |
| `Series.status` | `show.status`, mapped to `SeriesStatus` — **mapping table not yet defined, see §2 caveat** |
| `Episode.title` | matched episode's `title` (fill-if-null — this is the main payoff, currently 0/18,913 imported episodes have one) |
| `Episode.overview` | matched episode's `overview` (fill-if-null) |
| `Episode.airDate` | matched episode's `first_aired` (fill-if-null) |
| new `Episode` rows | Trakt episodes with no corresponding watched episode — created with no `EpisodeWatch` |

**Gaps found while writing this plan — real, concrete schema changes for a future pass, not applied now:**

1. **No `backdropUrl` field exists on `Series`.** The task explicitly asks for "poster/backdrop URLs if available," and Trakt's `images.fanart` is exactly that, but `Series` currently only has `posterUrl`. Needs `Series.backdropUrl String?` added.
2. **`Season` has no `rawMetadata`/`importBatchId`.** Every other enrichable model (`Series`, `Episode`, `EpisodeWatch`, `EpisodeNote`, `WatchlistItem`) got these in the last schema pass; `Season` was skipped because TV Time has nothing season-level to enrich beyond `seasonNumber`/`title`. Trakt does have season-level data worth keeping (season overview, season poster, Trakt's own per-season id) — needs `Season.rawMetadata Json?` and `Season.importBatchId String?` for consistency with the rest of the schema and to avoid losing season-level Trakt data with nowhere to put it.
3. **`ExternalIds` has no `rawMetadata`, confidence, or freshness tracking.** There's currently no field to record *how* a match was made — the confidence score, which candidate(s) were considered, when it was last verified against Trakt. Needs something like `ExternalIds.matchConfidence Float?`, `ExternalIds.matchedAt DateTime?`, `ExternalIds.rawMetadata Json?` (to hold the full scoring breakdown) — without this, a "why did MyTv think this was the right show" question is unanswerable after the fact except by re-deriving it from `ImportRawRow`/`ImportIssue`, which is possible but indirect.
4. **No episode-level image field.** `Episode` has no `stillUrl`/thumbnail column. Trakt does provide per-episode `images.screenshot`/`thumb`. Lower priority than the above three (the task's image requirement reads as primarily series-level "poster/backdrop"), but worth deciding on deliberately rather than by omission — flagged, not resolved, here.

None of these are applied in this pass. If/when a code-writing pass for Trakt enrichment happens, these four should go through the same kind of schema-plan review `docs/mytv-prisma-schema-plan.md` got before touching `schema.prisma`.

## 7. Risks / open questions

- **Anime episode numbering.** Long-running anime (§1) is exactly where TV Time, Trakt, TheTVDB, and AniDB-style absolute numbering most often disagree (season splits, filler-episode inclusion/exclusion, dub-vs-sub release differences). Expect the post-fetch episode-count sanity check (§3.2) to flag a disproportionate share of the anime-heavy titles in this dataset as `needs-review` even when the *show* match itself is correct — that's a signal to tune the mismatch tolerance for episode-heavy shows, not necessarily a matching failure.
- **`Series.status` mapping is unconfirmed** (§2) — needs one real sample response before the enum mapping is written.
- **Multi-result ambiguity for extremely common titles.** Generic titles with many international versions (the dataset doesn't obviously have many, but it's a known Trakt-search failure mode in general) may need a stricter auto-apply bar than the one proposed here; the tier thresholds in §3.3 are a starting proposal, not tuned against real Trakt responses yet.
- **Rate-limit numbers are current as of this session** (fetched from `docs.trakt.tv`, not hardcoded from memory) but should be re-confirmed at implementation time in case they've changed.

## 8. Explicitly not done in this pass

- No importer/enrichment code written.
- No `prisma/schema.prisma` changes — §6's four gaps are documented, not applied.
- No live calls to `api.trakt.tv` — all Trakt facts above came from reading `docs.trakt.tv` (documentation pages), which required no API key. No Trakt application/client_id was created or used.
- No dry-run mechanism exists yet for this feature (unlike the TV Time importer, which already has one) — per the task's own instruction, that's exactly why no live API calls were made.
