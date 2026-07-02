# MyTv V1 Prisma Schema Plan

Design proposal for evolving `prisma/schema.prisma` to (a) support the six V1 screens and (b) import + preserve the TV Time history documented in [`tvtime-data-audit.md`](./tvtime-data-audit.md). **This is a plan only — `prisma/schema.prisma` has not been modified.** Applying it is a separate, later step.

## 1. Constraints this plan is designed against

From the audit, in order of how much they shape the schema:

1. **No episode metadata in the import** (no titles/overviews/air dates/posters) — normalized tables must tolerate those fields being empty indefinitely, not just briefly until import finishes.
2. **Ratings and emotions are opaquely encoded** (`vote_key` suffix values don't map to a known scale yet) — the schema must store the raw value durably and leave room for a decoded value to be filled in *later without a migration*.
3. **Sensitive data (auth, tokens, IP/geolocation, social PII) must never enter the app database** — this is enforced by import-time filtering, not by the schema, but the schema should make it easy to keep that boundary (e.g. no table exists that a sensitive field could accidentally be routed into).
4. **Import bookkeeping is not app data** — raw rows, batch runs, and review flags belong in their own tables that the app's runtime queries never touch, so a bad import can be inspected/rolled back without contaminating `Series`/`EpisodeWatch`/etc.
5. **Series identity is name-based only** (§8.4 of the audit) — no unique constraint on `Series.title` should be added; two real shows can legitimately share a display name.
6. Everything from the original V1 scope still applies: series-first, one `EpisodeWatch` per (user, episode), deterministic `nextEpisode` computation, etc. — this plan extends that schema, it doesn't replace it.

## 2. Screens → schema mapping

| Screen | Query shape | Schema support |
| --- | --- | --- |
| **Home** | Composes the three sections below in one call | No new tables — same as today, `HomeService` fans out to the same three queries |
| **Recently Watched** | `EpisodeWatch` for user, order by `watchedAt desc, id desc`, cursor-paginated | Existing `@@index([userId, watchedAt])` on `EpisodeWatch` — unchanged |
| **Watch Next** | `UserSeriesProgress` where `status=WATCHING and nextEpisodeId is not null` | Existing `@@index([userId, status, lastWatchedAt])` — unchanged |
| **Haven't Watched For A While** | `UserSeriesProgress` where `status=WATCHING and lastWatchedAt < cutoff` | Same index as above, already leads with `userId, status` then range-scans `lastWatchedAt` — unchanged |
| **Watchlist** | `WatchlistItem` for user, order by `addedAt desc` | Existing `@@unique([userId, seriesId])` doubles as the lookup index — unchanged |
| **Episode details with notes** | `Episode` + its `Season`/`Series` + this user's `EpisodeWatch` (+ `EpisodeNote`) + this user's `EpisodeRating` + this user's `EpisodeEmotion`(s) | `EpisodeWatch` unique on `(userId, episodeId)` already gives a direct point lookup; **new** `EpisodeRating`/`EpisodeEmotion` models (§5) are keyed the same way for the same reason |

Nothing about the four home-screen-adjacent queries changes — this plan is additive. The only screen gaining new schema support is **episode details**, which needs ratings/emotions/history to be queryable per-episode even though V1's API doesn't expose endpoints for them yet (see §7 — data is imported and stored, not wired to the API in this pass).

## 3. Design principles

- **Nullable over invented.** Where TV Time doesn't give us data (episode titles, air dates), the field stays `null`. No placeholder strings like `"Episode 5"` get written by the importer — a `null` is honest, a placeholder is a lie the UI has to know to detect.
- **Opaque values are stored raw, with a parallel nullable "decoded" column.** Ratings/emotions get a `rawValue` (what we actually received) and a `normalizedValue`/`normalizedEmotion` (nullable, filled in once the encoding is confirmed). This means decoding the scale later is a backfill `UPDATE`, not a schema migration.
- **`rawMetadata Json?` is the escape hatch, not the primary storage.** Anything that maps cleanly to a real column gets a real column (so it's indexable/queryable/typed). Anything that doesn't map to a V1 product concept (comment like-counts, spoiler flags, which device a watch happened on) goes into `rawMetadata` so it's preserved without forcing a column for every oddball TV Time field.
- **Import bookkeeping tables have no hard relations into app tables, and vice versa.** App tables (`Series`, `Episode`, `EpisodeWatch`, ...) get a plain nullable `importBatchId String?` scalar column — a breadcrumb, not a foreign key. This is deliberate: the app schema shouldn't `CASCADE` or break if an import batch record is pruned, and the import/bookkeeping tables should be droppable or even eventually moved to a separate schema/database without touching `Series`/`EpisodeWatch` at all. The detailed, queryable link between a raw import row and the app row(s) it produced lives on the `ImportRawRow` side (`resolvedEntityType`/`resolvedEntityId`), not the other way around — one raw row resolves to one app row, but one app row can be the product of several raw rows (e.g. the same watch event appearing in both `tracking-prod-records.csv` and `tracking-prod-records-v2.csv`), so the "many raw → one app" direction is the one that needs to be a queryable pointer.
- **Single current value where TV Time's product model has one, small history signal where it doesn't warrant a whole event table.** `EpisodeWatch` stays unique per `(userId, episodeId)` (no rewatch event history in V1 — that's an explicit non-goal carried over from the original schema). But rewatch *counts* are a real, cheap-to-keep signal, so `EpisodeWatch` gains a `rewatchCount Int` rather than silently dropping it into `rawMetadata` where it'd be invisible to queries.
- **Movies are never modeled.** Per the audit, movie rows are identifiable at raw-import time (`entity_type = 'movie'`, `episode_id = '0'` + `movie_name` populated) and are preserved in the raw layer, but no normalized `Movie` table exists in this plan — V1 is series-only, and inventing a movie schema nobody will query yet is pure speculation.

## 4. Changes to existing models

All changes are additive or widen a constraint — nothing here is destructive, and nothing requires backfilling existing seed data with new values (new columns are nullable or have defaults).

| Model | Change | Why |
| --- | --- | --- |
| `Episode` | `title String` → `title String?` | The import can't populate a real title (§1.1). Forcing a non-null title would mean inventing placeholder text, which is worse than a `null` the client already has to handle (episodes can already lack `overview`/`airDate`). |
| `Episode` | + `rawMetadata Json?` | Holds TV Time's internal `episode_id`/`ep_id` (§5 of the audit — proposed home for the "tvtime id" instead of extending `ExternalIds`, which is reserved for Trakt/TMDB/IMDB) plus anything else from the source rows that doesn't map to a column. |
| `Episode` | + `importBatchId String?` | Breadcrumb, see §3. |
| `Series` | + `rawMetadata Json?` | Same reasoning as `Episode.rawMetadata` — holds TV Time's `tv_show_id`. |
| `Series` | + `importBatchId String?` | Breadcrumb. |
| `EpisodeWatch` | + `rewatchCount Int @default(0)` | TV Time tracks rewatches (`rewatched_episode.csv`, `rewatch-episode-*` rows in `tracking-prod-records-v2.csv`). V1 still doesn't model rewatch *events*, but dropping the count entirely loses a real, useful signal for a future "watched 3 times" badge. `@default(0)` keeps every existing/new watch valid without a backfill. |
| `EpisodeWatch` | + `watchDateApproximate Boolean @default(false)` | Addresses the audit's bulk-import caveat: `fill-previous` actions stamp many episodes with one `created_at`, so that date is a rough guess, not a real watch date. Setting this `true` on import lets the UI show "date approximate" instead of presenting a guess as fact. |
| `EpisodeWatch` | + `rawMetadata Json?` | Holds `bulk_type`, watch source device, and which source file(s) contributed (§7.6 of the audit). |
| `EpisodeWatch` | + `importBatchId String?` | Breadcrumb. |
| `EpisodeNote` | + `rawMetadata Json?` | Holds the social metadata `episode_comment.csv` carries that has no MyTv equivalent — `nb_likes`, `spoiler_count`, `posted_on_twitter`/`posted_on_fb`, `highlight_level` (audit §3.5) — preserved, not silently dropped, without pretending MyTv has a "likes" feature. |
| `EpisodeNote` | + `importBatchId String?` | Breadcrumb. |
| `WatchlistItem` | + `rawMetadata Json?` | Holds which of the reconciled TV Time sources (`user_show_special_status.csv` vs `tracking-prod-records-v2.csv`'s `is_for_later`) agreed/disagreed, for traceability if a reconciliation turns out wrong. |
| `WatchlistItem` | + `importBatchId String?` | Breadcrumb. |

**Explicitly not changed:** `Series.status` stays a plain enum with no import-driven default beyond `ONGOING` (TV Time doesn't tell us broadcast status — audit open question #4-adjacent, revisit once Trakt is wired up). `ExternalIds` stays Trakt/TMDB/IMDB-only — TV Time's internal ids go in `rawMetadata` instead, per the audit's own recommendation, so this table doesn't gain a `tvtimeId` column that means something different from its other three. No `@@unique` is added on `Series.title` (§1.5).

## 5. New models: ratings & emotions

Two separate concerns get separate models, because they're genuinely different shapes of data (audit §3.3/§3.4): a numeric-but-undecoded per-episode rating, a categorical-but-undecoded per-episode emotion (multiple allowed per episode), and a *decoded* whole-series rating that's a different feature entirely.

```prisma
// A user's rating for one episode. TV Time's rating scale is not confirmed
// from the export alone (see docs/tvtime-data-audit.md §3.3) — rawValue is
// stored as received; normalizedValue is filled in later, once the 0.5–10
// half-star scale (or whatever it actually is) is confirmed, without a migration.
model EpisodeRating {
  id              String   @id @default(uuid())
  userId          String
  episodeId       String
  rawValue        Int
  normalizedValue Decimal? @db.Decimal(3, 1)
  rawMetadata     Json?
  importBatchId   String?
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  user    User    @relation(fields: [userId], references: [id], onDelete: Cascade)
  episode Episode @relation(fields: [episodeId], references: [id], onDelete: Cascade)

  @@unique([userId, episodeId])
  @@index([episodeId])
}

// A user's emotional reaction(s) to one episode. Unlike ratings, TV Time
// allows more than one reaction per episode, so this is not unique per
// (userId, episodeId) alone — see docs/tvtime-data-audit.md §3.4.
model EpisodeEmotion {
  id                String   @id @default(uuid())
  userId            String
  episodeId         String
  rawValue          Int
  normalizedEmotion String?
  rawMetadata       Json?
  importBatchId     String?
  createdAt         DateTime @default(now())

  user    User    @relation(fields: [userId], references: [id], onDelete: Cascade)
  episode Episode @relation(fields: [episodeId], references: [id], onDelete: Cascade)

  @@unique([userId, episodeId, rawValue])
  @@index([episodeId])
}

// Whole-series rating (tv_show_rate.csv) — a different feature from episode
// ratings, and unlike them this one IS on a known, decoded scale (observed
// values like "4.50", "5" — a 0–5 scale), so it gets a real Decimal value
// from day one instead of a rawValue/normalizedValue pair.
model SeriesRating {
  id            String   @id @default(uuid())
  userId        String
  seriesId      String
  value         Decimal  @db.Decimal(3, 2)
  rawMetadata   Json?
  importBatchId String?
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt

  user   User   @relation(fields: [userId], references: [id], onDelete: Cascade)
  series Series @relation(fields: [seriesId], references: [id], onDelete: Cascade)

  @@unique([userId, seriesId])
  @@index([seriesId])
}
```

Notes:
- Each new model's `@relation` requires the standard Prisma opposite-side array field: `User` gains `episodeRatings EpisodeRating[]`, `episodeEmotions EpisodeEmotion[]`, `seriesRatings SeriesRating[]`; `Episode` gains `ratings EpisodeRating[]`, `emotions EpisodeEmotion[]`; `Series` gains `ratings SeriesRating[]`. Omitted from the code blocks above for brevity, but required for `prisma validate` to pass when this is actually applied.
- `EpisodeRating`/`EpisodeEmotion`/`SeriesRating` key off `(userId, episodeId)` / `(userId, seriesId)` directly — **not** through `EpisodeWatch` — because TV Time data shows ratings/emotions can exist without a corresponding tracked watch event in this export, and forcing them through `EpisodeWatch` would mean either inventing a watch event that didn't happen or silently dropping the rating. Keeping them independent means the importer can write a rating even when the matching watch is ambiguous or missing, and flag *that* in the import review — instead of the schema forcing a bad choice.
- No lookup/enum table for emotion types yet (e.g. mapping `rawValue: 19` → `"love"`) — that would mean guessing the taxonomy today. Once TV Time's emotion icon set is decoded (a `needs-review` follow-up per the audit), adding an `EmotionType` lookup table and backfilling `normalizedEmotion` is a small additive change, not a redesign.
- `EpisodeNote` deliberately still requires an `EpisodeWatch` to attach to (unchanged, §4) — it's "your note on watching this episode," which only makes sense in the context of a watch. Imported comments with no matching watch event are a data-quality edge case handled by the importer's `needs-review` output, not by loosening this constraint.

## 6. New models: import bookkeeping

Fully separate from the app schema above — no `@relation` reaches into `Series`/`Episode`/`EpisodeWatch`/etc. from here, only the reverse (loose `importBatchId` breadcrumbs, §3).

```prisma
enum ImportStatus {
  PENDING
  RUNNING
  COMPLETED
  FAILED
}

enum ImportIssueSeverity {
  INFO
  WARNING
  ERROR
}

// One row per importer run. skippedFiles records which source files were
// excluded wholesale (sensitive data — see docs/tvtime-data-audit.md §4) for
// this run, so the policy is auditable per-batch, not just documented in prose.
model ImportBatch {
  id           String       @id @default(uuid())
  source       String       // e.g. "tvtime-export"
  status       ImportStatus @default(PENDING)
  startedAt    DateTime     @default(now())
  finishedAt   DateTime?
  skippedFiles Json?        // [{ file: string, reason: string }]
  notes        String?

  rawRows ImportRawRow[]
  issues  ImportIssue[]
}

// One row per source CSV row that was imported (i.e. NOT one of the
// wholesale-excluded sensitive files). payload is the raw row, untyped and
// unmodified. resolvedEntityType/Id are filled in by the transform pass once
// it decides what this row became — this is the queryable "which raw rows
// fed this app row" direction (many raw rows can resolve to one app row,
// e.g. the same watch logged in both tracking-prod-records.csv and
// tracking-prod-records-v2.csv — see docs/tvtime-data-audit.md §3.1).
model ImportRawRow {
  id                String    @id @default(uuid())
  importBatchId     String
  sourceFile        String
  sourceRowNumber   Int
  payload           Json
  resolvedEntityType String?  // e.g. "EpisodeWatch", "WatchlistItem"
  resolvedEntityId   String?
  processedAt       DateTime?
  createdAt         DateTime  @default(now())

  importBatch ImportBatch @relation(fields: [importBatchId], references: [id], onDelete: Cascade)

  @@index([importBatchId, sourceFile])
  @@index([resolvedEntityType, resolvedEntityId])
}

// Anything the transform pass couldn't resolve automatically — ambiguous
// series-name duplicates, watchlist source conflicts, comments with no
// matching watch event, count-mismatch sanity-check failures, etc. Mirrors
// needs-review.json from docs/tvtime-data-audit.md §7.5, but queryable and
// tied to a specific batch/row instead of being a flat file.
model ImportIssue {
  id              String              @id @default(uuid())
  importBatchId   String
  severity        ImportIssueSeverity
  sourceFile      String?
  sourceRowNumber Int?
  relatedEntityType String?
  relatedEntityId   String?
  message         String
  resolved        Boolean             @default(false)
  createdAt       DateTime            @default(now())

  importBatch ImportBatch @relation(fields: [importBatchId], references: [id], onDelete: Cascade)

  @@index([importBatchId, resolved])
  @@index([relatedEntityType, relatedEntityId])
}
```

**Why one generic `ImportRawRow` table instead of one typed table per source file** (the audit's §7.1 sketch): with ~45 non-excluded files at a few thousand rows each (max ~24k), a `payload Json` column queried with Postgres's native JSONB operators is more than fast enough, and it avoids maintaining 45 near-identical Prisma models that exist only for archival fidelity. If a specific source file turns out to need repeated, performance-sensitive structured queries during the transform pass (the audit flags `tracking-prod-records-v2.csv` as the biggest/most-queried one), a typed raw table for *that* file specifically is a cheap, isolated addition later — it doesn't require redesigning this layer.

`skipped-sensitive-fields.json` from the audit's §7.5 stays a **committed, static file**, not a table — it's a policy decision that doesn't vary per import run (aside from the per-batch `skippedFiles` breadcrumb above, which records what actually happened for *that* run).

## 7. What this plan deliberately does not do

- **No new API endpoints.** Ratings/emotions/series-ratings are storage-only in this plan — nothing in `src/modules/*` changes. Surfacing them (e.g. on the episode-details screen) is a separate follow-up once the data is actually imported and the rating/emotion scale is decoded.
- **No importer code.** This is schema only, per the task.
- **No `prisma/schema.prisma` edit and no migration.** This doc is the reviewable diff; applying it is `prisma migrate dev --name add_ratings_emotions_and_import_bookkeeping` as a distinct next step.
- **No `Movie` model.** Movies stay raw-only (§3), consistent with V1 being series-first.
- **No emotion/rating enum decoding.** Both stay `rawValue Int` until the encoding is confirmed — guessing it now would mean a silent-data-corruption risk if the guess is wrong.

## 8. Net effect on `prisma/schema.prisma`

Summary of the diff this plan describes, for quick review:

- **Widened:** `Episode.title` becomes optional.
- **Extended (new nullable columns, no default-value backfill needed beyond `@default`s shown):** `Series`, `Episode`, `EpisodeWatch`, `EpisodeNote`, `WatchlistItem` each gain `rawMetadata Json?` + `importBatchId String?`; `EpisodeWatch` additionally gains `rewatchCount Int @default(0)` and `watchDateApproximate Boolean @default(false)`.
- **New app-facing models:** `EpisodeRating`, `EpisodeEmotion`, `SeriesRating`.
- **New bookkeeping models:** `ImportBatch`, `ImportRawRow`, `ImportIssue`, plus `ImportStatus`/`ImportIssueSeverity` enums.
- **Unchanged:** `User`, `Season`, `UserSeriesProgress`, `ExternalIds`, and every existing relation/index/unique constraint from the current schema.

Everything above is additive or widening — applying this plan is a safe forward migration against the existing seed data with no destructive step.
