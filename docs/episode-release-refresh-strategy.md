# Episode release refresh — audit and strategy

Status: **design only, nothing implemented, no data changed.** This document answers "how does the
server currently learn about new episodes?" and proposes a safe path toward automating it. It does
not add any code, cron job, or script.

## TL;DR

- **Today, nothing updates the episode catalog automatically.** No cron, no scheduled job, no
  startup hook, no HTTP refresh endpoint. The only way a newly-released episode enters the database
  is a developer manually running `npm run tmdb:enrichment-dry-run` → reviewing the plan → manually
  running `npm run tmdb:apply-plan` (or the one-off `next-episode-backfill`/`manual-progress-corrections`
  scripts) from a terminal.
- The UI (`GET /home`, `GET /series/:id`, pull-to-refresh, screen refocus) only ever **reads current
  DB state**. It cannot discover an episode that isn't in Postgres yet, no matter how often it
  refetches.
- The project's own design docs (`episode-numbering-and-season-shift-risk.md`,
  `metadata-provider-strategy.md`, `status-model-plan.md` §7a/§11) treat full automation as unsafe
  today, as a deliberate choice, because of a confirmed class of failures where a provider's episode
  numbering doesn't match what's already in the database (season-shift / absolute-numbering
  collisions — see below) — applying blindly can orphan already-watched episodes and corrupt Watch
  Next.
- **Recommended minimal next step:** a read-only, scheduled *dry-run* report (no writes at all) for
  provider-confirmed, actively-tracked series, running daily. Only after that report has been
  reviewed for a while and shown to be trustworthy should a real "apply" mode be added, and even
  then scoped to the safest possible subset (see §6).

---

## 1. Current state (audit findings)

### 1.1 Scheduled jobs / cron

None. `package.json` has no `@nestjs/schedule`, `node-cron`, or any cron dependency. There is no
`railway.json`/`railway.toml`/`Procfile`, and no `.github/workflows/` directory in this repo. Nothing
in the codebase uses `@Cron`, `@Interval`, or `@Timeout`.

### 1.2 Startup hooks

`src/main.ts`'s `bootstrap()` does exactly four things: create the Nest app, enable CORS, install the
global `ValidationPipe`, mount Swagger, and `listen()`. `src/app.module.ts` wires the feature modules
and `DevUserMiddleware` — no `onModuleInit`/`onApplicationBootstrap` exists anywhere in `src/`. Nothing
runs automatically when the server process starts beyond standard Nest module construction.

### 1.3 On-demand refresh endpoint

None. No controller under `src/modules/{home,me,watchlist,episodes,series}` exposes anything that
triggers a provider re-fetch. Every read endpoint (`GET /home`, `GET /series/:id`, `GET /me/watch-next`,
etc.) only queries Postgres via Prisma. There is no "refresh this series against TMDb" button
anywhere in the API surface today.

### 1.4 How the catalog actually grows — manual pipelines

Every one of these is a standalone `ts-node` script at the server repo root, invoked by a developer
from a terminal. None are imported by `src/`, none run inside the Nest process, and none are wired to
any scheduler or CI workflow:

| Directory | Purpose | npm script | Automated? |
|---|---|---|---|
| `tmdb-enrichment/` | Primary, working TMDb matching + apply pipeline (`tmdb-client.ts`, `scoring.ts`, `data-quality.ts`, `single-series-safety.ts`, `apply-plan.ts`) | `tmdb:enrichment-dry-run`, `tmdb:apply-plan`, `tmdb:enrichment-apply` | No — manual dry-run then manual apply |
| `trakt-enrichment/` | Parallel Trakt matching pipeline | `trakt:backfill-tvtime-show-id`, `trakt:enrichment-dry-run` | No — and currently **blocked**: OAuth registration is broken for this account per `docs/metadata-provider-strategy.md` §2, so it's dry-run-only regardless |
| `next-episode-backfill/` | One-time derivation of `UserSeriesProgress.nextEpisodeId` from the existing catalog | `next-episode:backfill` | No |
| `secondary-provider-audit/` | TVmaze client + scoring + comparison against TMDb's picks — **report-only, never writes** | *(no npm script — run via raw `ts-node`)* | No |
| `watch-next-review/`, `watch-next-audit/`, `stale-series-audit/`, `tvtime-parity-audit/`, `image-coverage-audit/`, `manual-progress-corrections/` | Various audit/correction pipelines, several with their own single-series safety logic | *(no npm scripts at all)* | No |
| `import-tvtime/` | Original one-time CSV importer that seeded the catalog from a TV Time export | `import:tvtime`, `import:tvtime:dry-run` | No — this is how the app was bootstrapped, not an ongoing new-episode mechanism |

Only `tmdb-enrichment/` has ever actually written catalog data (184+ of 433 series matched, per
`status-model-plan.md` §11). Trakt has no apply step at all. TVmaze has no apply step at all — it's
explicitly comparison/audit-only (`secondary-provider-audit/tvmaze-*.ts`, `tvmaze-compare.ts`).

### 1.5 TVmaze specifically

Built and unit-tested (`secondary-provider-audit/tvmaze-client.ts`, `tvmaze-scoring.ts`,
`tvmaze-compare.ts`), plus one targeted single-series manual correction
(`manual-progress-corrections/run-mom-tvmaze-enrichment.ts`). It has **never written to the
database** — every use so far is "fetch TVmaze's view of a series and compare it to TMDb's,
report the diff." `metadata-provider-strategy.md` recommends keeping it exactly that way: a
disambiguation signal on flagged series, never a silent catalog source.

### 1.6 Does UI refetch alone update `nextEpisodeId`?

No. `GET /home`, `GET /series/:id`, pull-to-refresh, and screen-refocus refetches (all audited in the
mobile app in a prior pass) only re-read `UserSeriesProgress`/`Episode` rows that already exist in
Postgres. `nextEpisodeId` is a cached column (`UserSeriesProgress.nextEpisodeId`), recomputed only by
specific write paths already in the codebase:

- `POST /episodes/:episodeId/watch` (`EpisodeWatchService.markWatched`)
- `DELETE /episode-watches/:watchId` (`EpisodeWatchService.unwatchEpisode`)
- `POST /seasons/:seasonId/watch-all`, `POST /series/:seriesId/watch-all-released`
- `PATCH /series/:seriesId/status`
- The one-time `next-episode-backfill/` script
- The TMDb apply step, when it runs

None of these are triggered by a client GET request. If a new episode airs and nobody runs a TMDb
enrichment pass, the app will keep recommending the same (now stale) `nextEpisodeId` indefinitely —
refreshing the UI more often changes nothing.

### 1.7 Why this is a deliberate gap, not an oversight

Three existing docs establish this explicitly:

- **`episode-numbering-and-season-shift-risk.md`** — providers frequently disagree about how a
  series splits into seasons (anime absolute-numbering vs. TV Time's per-cour seasons, reboots,
  specials). Confirmed concrete failure: Jujutsu Kaisen — TMDb represents it as one 59-episode
  absolute-numbered season vs. the imported 3-season/54-episode structure; blindly applying TMDb's
  numbering would orphan ~30 already-watched episodes and recreate them as unwatched duplicates,
  corrupting Watch Next. There is **no automated detector** for this today — it's caught by the
  `data-quality.ts`/`single-series-safety.ts` heuristics and a hardcoded risk list
  (`src/common/stale-series-trust.ts`'s `EPISODE_NUMBERING_RISK_LIST_TITLES` /
  `KNOWN_SEASON_SHIFT_ORPHAN_TITLES`), which only cover series discovered so far, not a general
  guarantee.
- **`status-model-plan.md`** §7a/§11 — confirms only the TMDb apply step exists, is dry-run-first,
  and Trakt/TVmaze remain report-only. States this as a stable, ongoing state, not a TODO with a
  date.
- **`metadata-provider-strategy.md`** — explicitly recommends hard-blocking auto-apply whenever two
  confident providers propose structurally different episode/season data for the same series,
  routing to manual review instead.

The common thread: **automating "learn about new episodes" is safe; automating "silently rewrite
season/episode structure" is not**, and today's pipelines don't cleanly separate those two things at
the API-client level — a naive "just run the existing apply step on a timer" would inherit the
season-shift risk with no human in the loop.

---

## 2. Design: a safe scheduled refresh strategy

### 2.1 Scope — what this refresh job would and would not do

**In scope**: for a series whose provider match is already confirmed (has an `ExternalIds.tmdbId`),
periodically re-fetch that provider's episode list and:
- add episodes that don't exist yet in `Episode` (new releases, or previously-unannounced episodes
  now confirmed with an air date)
- update `airDate`/`title`/`overview`/`imageUrl`/`runtimeMinutes` on **existing, still-matching**
  episodes when the provider's data changed (e.g. a placeholder air date firmed up)
- update `Series.releaseStatus` (RETURNING/ENDED/CANCELLED/etc.) from the provider
- recompute `UserSeriesProgress.nextEpisodeId`/`userStatus` for that series afterward, using the
  exact same pure logic the live app already uses (`deriveUserStatusFromNextEpisode`,
  `findFirstUnwatchedEpisodeId` — see §2.5)

**Explicitly out of scope** (these remain manual, human-reviewed actions, same as today):
- discovering a NEW provider match for a series that doesn't have one yet (that's what
  `tmdb-enrichment-dry-run` + review is for — matching is the risky, judgment-heavy step, not
  fetching episodes for an already-confirmed match)
- re-scoring or re-deciding which TMDb id a series maps to
- restructuring seasons (splitting/merging/renumbering) — if a provider's season structure for an
  already-matched series no longer lines up with what's in the DB (episode count shrinks, a season
  number disappears, etc.), that's a **season-shift signal**, and this job skips the series and
  reports it rather than reconciling it
- anything for a series without a confirmed `tmdbId`

### 2.2 Candidate selection

```
tracked series
  WHERE UserSeriesProgress.userStatus IN (WATCHING, CAUGHT_UP)   -- "actively relevant" set
    AND Series.externalIds.tmdbId IS NOT NULL                    -- provider-confirmed only
    AND Series.title NOT IN EPISODE_NUMBERING_RISK_LIST_TITLES   -- src/common/stale-series-trust.ts
    AND Series.title NOT IN KNOWN_SEASON_SHIFT_ORPHAN_TITLES     -- same file
    AND Series.releaseStatus IN (RETURNING, IN_PRODUCTION, UNKNOWN) -- ENDED/CANCELLED series have nothing new coming
```

Rationale per clause:
- `WATCHING`/`CAUGHT_UP` only: `DROPPED`/`PAUSED`/`WATCHLIST`/`COMPLETED` series either have
  explicit personal intent that shouldn't be disturbed (dropped/paused/watchlist) or are, by
  definition, not expecting anything new (completed). Same "protected statuses" boundary the rest
  of the codebase already draws (`checkWatchAllAllowed`'s `PROTECTED_STATUSES`,
  `next-episode-backfill`'s `SKIPPED_USER_STATUSES`).
- `externalIds.tmdbId IS NOT NULL`: this job never invents a match. Series with no confirmed match
  are entirely out of scope — they stay exactly as manual-review-only as they are today.
- The two risk lists from `stale-series-trust.ts` (already reused by `HomeService`/
  `MeService.getWatchNext` for the same "don't trust this series' next-episode data" purpose) —
  reused here unchanged rather than reimplemented, so the "don't trust" list can't drift between
  the read path and this refresh job.
- `releaseStatus`: skip anything already known to be finished. Cheap filter, avoids wasted provider
  calls for series that structurally cannot have new episodes.

Provider priority for episode-catalog re-fetch, per series (future-proofing, only TMDb exists today):
1. **TMDb**, if `externalIds.tmdbId` is set (today: the only populated case)
2. **TVmaze**, if a future confirmed TVmaze match exists and TMDb doesn't have one (`tvmazeId` would
   need to be added to `ExternalIds` — not present today; this is a placeholder for when/if TVmaze
   graduates from audit-only to a real secondary source, which `metadata-provider-strategy.md`
   deliberately did not recommend doing yet)
3. **TheTVDB**, reserved for anime absolute-order cases per the task's ask — no client, no schema
   support, no research done yet. Listed here only so the priority order is documented before any
   code exists; do not build this without first writing the equivalent of
   `metadata-provider-strategy.md`'s evaluation for TheTVDB specifically.

### 2.3 What "safe" means for a single series' refresh (per-series algorithm sketch)

For each candidate series:

1. Fetch the provider's current episode list (reusing `tmdb-enrichment/tmdb-client.ts` — already has
   rate limiting/backoff/caching built in, see §1 of that file).
2. **Season-shift guard**: compare the provider's season count and per-season episode counts against
   what's already in the DB for this series.
   - If every season MyTv already has episodes for still has the same-or-larger episode count from
     the provider, AND matching episodes' `episodeNumber` line up 1:1 for previously-seen episodes
     → safe to proceed.
   - If a season's episode count *shrank*, a season disappeared, or an existing episode's position
     no longer matches → **do not write anything for this series**; flag it in the report as
     `SEASON_SHIFT_SUSPECTED` and (recommended) add it to `KNOWN_SEASON_SHIFT_ORPHAN_TITLES` for
     human review, same remediation path already used for the three titles currently in that list.
3. If the guard passes, diff the provider's episode list against the DB:
   - Episodes present in both, same identity (`seasonNumber`+`episodeNumber`) → update only the
     specific fields listed in §2.1 (title/overview/airDate/imageUrl/runtimeMinutes), never touch
     `id`, never touch anything watch-related.
   - Episodes present in the provider but not the DB → create them. New `Episode` rows only; no
     existing row is ever deleted (hard rule, see §2.4).
   - Episodes present in the DB but not the provider → **do not delete**. Report as
     `EPISODE_MISSING_FROM_PROVIDER` (could be a legitimate provider data gap, could be another
     season-shift signal) and leave the DB row untouched.
   - `Series.releaseStatus` → update from the provider's status (`mapTmdbStatusToReleaseStatus`,
     already exists in `tmdb-enrichment/release-status-mapping.ts`) — this one already has a
     precedent of being safely provider-driven and not user-controlled.
4. Recompute `UserSeriesProgress` (§2.5).
5. Record one line item per series in the run's report (§2.6), regardless of outcome.

### 2.4 Hard safety rules (apply to every run, no exceptions/flags to bypass them)

- **Never auto-enrich an unconfirmed or risky match.** No `tmdbId` → out of scope entirely (§2.2).
  This job only ever refreshes an *already-established* match; it never runs scoring/matching logic.
- **Never overwrite `EpisodeWatch.watchedAt`.** This job never touches the `EpisodeWatch` table at
  all — only `Episode`, `Series`, and (for recompute) `UserSeriesProgress`.
- **Never delete an `Episode` row.** Provider data going backwards (an episode disappearing from the
  provider's response) is reported, never acted on destructively.
- **Never change a manual override.** There is currently no explicit "manually edited" flag on
  `Episode`/`Series` — until one exists, the conservative rule is: only ever write the specific
  provider-sourced columns listed in §2.1, never touch `rawMetadata`, `importBatchId`, or anything
  outside that fixed field list.
- **Never move a series out of `DROPPED`/`PAUSED`.** Excluded from candidate selection entirely
  (§2.2) rather than included-but-protected, so there's no code path where this job even reads that
  series' episodes, let alone writes to it. (Matches the existing precedent in
  `next-episode-backfill/derive-next-episode.ts`'s `SKIPPED_USER_STATUSES` and
  `checkWatchAllAllowed`'s `PROTECTED_STATUSES` — this job is stricter than either, since it doesn't
  even offer a `force` override the way those two do; there is no interactive user to ask.)
- **If providers disagree, report only.** Applies today by construction, since only one provider
  (TMDb) is ever actually queried for a given series (§2.2's priority order picks exactly one). The
  rule is stated explicitly here so that if TVmaze/TheTVDB priority tiers are ever implemented for
  real, cross-provider disagreement on the same series becomes a report line, never an
  auto-resolution.

### 2.5 Recomputing `UserSeriesProgress` after a catalog update

Reuse existing, already-tested pure logic rather than writing new status-derivation rules:

- `findFirstUnwatchedEpisodeId` (`src/modules/series/series-query-helpers.ts`) — same "first
  released, unwatched episode in season/episode order" rule every live write path already uses.
- `deriveUserStatusFromNextEpisode` (`src/common/derive-user-status.ts`) — same
  WATCHING/CAUGHT_UP/COMPLETED derivation `markWatched` and `watch-all` already use.
- Protected-status handling: reuse the same `PROTECTED_STATUSES` (`DROPPED`/`PAUSED`) pattern —
  moot here since §2.2 already excludes those series from candidate selection, but worth restating:
  even if a series' status changed to `DROPPED`/`PAUSED` *during* a run (a race with a live user
  action), the recompute step should re-check `userStatus` immediately before writing and skip the
  update if so, rather than trusting the value read at candidate-selection time.

This keeps the refresh job from ever inventing a *second* definition of "what's next" that could
drift from what `POST /episodes/:episodeId/watch` computes for the same data.

### 2.6 Report — every run, always

Whether dry-run or apply, every invocation produces a JSON report (same convention as
`tmdb-enrichment`'s existing dry-run plan output), including at minimum:

```
{
  "runAt": "...",
  "mode": "dry-run" | "apply",
  "seriesConsidered": number,
  "seriesSkipped": [{ "seriesId", "title", "reason": "no-tmdb-id" | "risk-list" | "release-status-finished" | ... }],
  "seriesRefreshed": [{
    "seriesId", "title",
    "episodesAdded": [...ids/labels],
    "episodesUpdated": [...fields changed],
    "releaseStatusChange": { "from", "to" } | null,
    "nextEpisodeChange": { "from", "to" } | null,
    "userStatusChange": { "from", "to" } | null
  }],
  "seriesFlagged": [{ "seriesId", "title", "reason": "SEASON_SHIFT_SUSPECTED" | "EPISODE_MISSING_FROM_PROVIDER", "detail": "..." }],
  "errors": [{ "seriesId", "title", "error": "..." }]
}
```

This mirrors the existing dry-run-plan pattern (`tmdb-apply-plan.json`) so the review habits already
established for that pipeline transfer directly to this one.

---

## 3. Implementation options

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| **NestJS `@nestjs/schedule` `@Cron` job inside the running server** | Runs wherever the app already runs, no extra infra, easy to add an admin endpoint to trigger it on demand too | Runs in the same process serving live traffic — a slow/stuck provider call or a bug could affect request latency/memory; couples "web server uptime" to "refresh cadence" (a redeploy resets any in-progress run) | Reasonable for V2 once the job is proven safe; not the first step |
| **Railway cron / scheduled command** (separate scheduled service hitting a script or a protected endpoint) | Isolated from the live API process; failure doesn't affect user-facing uptime; matches how a "batch job" conceptually differs from a "request handler" | Requires Railway-specific configuration (not yet present in this repo — no `railway.json`); another moving part to monitor | Good target for V2, once the underlying script is proven via manual/GitHub Actions runs |
| **Manual admin endpoint** (`POST /admin/refresh-episodes` or similar, dry-run by default) | Reuses existing NestJS auth/module wiring; lets a human trigger a refresh on demand from Swagger/Postman without shelling in; natural place to also expose "refresh just this one series" | Still needs *something* to call it on a schedule (this alone doesn't solve "learn about new episodes automatically") — and this app has no auth beyond the hardcoded dev user yet, so this endpoint would need to stay dev-only or gain real auth first | Useful as a companion to whichever scheduling option is chosen, not a replacement for one |
| **Script run by GitHub Actions (scheduled workflow) or a local/cron command** | Zero coupling to the running server; identical mental model to the existing `ts-node <pipeline>/run-*.ts` scripts, just triggered by a `schedule:` trigger instead of a human; easiest to review/audit since it's "the same script, just automated"; easiest to turn off (disable the workflow) if something looks wrong | Requires CI secrets for `DATABASE_URL`/`TMDB_API_KEY` if run outside the existing environment; report output needs somewhere to land (commit to repo? Slack/email? log only?) | **Recommended for the first real implementation** — closest to "automate exactly the manual process that already exists and is trusted," lowest blast radius, easiest rollback |

## 4. Recommended minimal first implementation

1. **Write a new script**, `episode-release-refresh/run-refresh.ts` (new top-level pipeline directory,
   matching the existing convention of `tmdb-enrichment/`, `next-episode-backfill/`, etc.), that
   implements §2.2–§2.6 with **dry-run as the only mode initially — no `--apply` flag at all yet**.
   It only ever reads from TMDb and the DB, and produces the report from §2.6. Zero writes, so there
   is no rollback story to design yet.
2. Add an npm script (`episode-refresh:dry-run`, matching the existing `tmdb:enrichment-dry-run`
   naming convention) so it can be run manually first, exactly like every other pipeline in this
   repo today.
3. **Run it manually** against the current database a handful of times over a couple of weeks,
   reviewing the report each time: does `seriesFlagged` correctly catch known-risky series? Does
   `seriesRefreshed` look plausible against what's actually airing? Any unexpected `errors`?
4. Once the report has been trustworthy for a while, wire it into a **scheduled GitHub Actions
   workflow** (daily, per §5's recommended cadence) running the *same dry-run script*, posting or
   storing the report somewhere visible (a workflow artifact, or committing to a `reports/` folder,
   or a Slack webhook — implementation detail deferred, but "review location" should be decided
   before turning this on so reports don't just disappear into CI logs no one reads).
5. **Only after that**, add a real `--apply` mode (reusing `apply-plan-writes.ts`-style helpers from
   `tmdb-enrichment/` for the actual Prisma writes, wrapped in a transaction per series so a
   mid-series failure can't leave a series half-updated), initially gated to run manually
   (`episode-refresh:apply`) before ever being added to the scheduled workflow. This mirrors exactly
   how `tmdb-enrichment` itself evolved (dry-run first, apply added later, apply still requires an
   explicit flag today).

**Recommended cadence once scheduled**: daily. New episodes for a given series air at most a
few times a week even for the most frequent shows; daily is frequent enough that "Watch Next" is
never more than ~24h stale, while being infrequent enough to keep TMDb API usage low (well within
the existing client's rate limiting) and to keep the size of each report reviewable.

---

## 5. Answers to the audit questions, restated plainly

- **How often does the server currently learn about newly released episodes?** Never, automatically.
  Only when a developer manually runs the TMDb enrichment pipeline (or a targeted manual-correction
  script) from a terminal.
- **Does any cron/job/scheduled task update provider catalogs and recompute `nextEpisodeId`?** No —
  confirmed absent (no `@nestjs/schedule`, no cron config, no CI schedule, no startup hook).
- **Does data only change when manual enrichment/backfill scripts are run?** Yes, exactly — that is
  the entirety of how the catalog has ever grown beyond the initial TV Time import.
