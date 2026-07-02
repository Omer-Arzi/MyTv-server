# TV Time Export — Data Audit

Audit of the personal data export dropped at `./tvtime-export/` (72 CSV files, gitignored, never committed). This document is research only — **no importer code or schema changes were made as part of this audit.**

Scope: one user's TV Time account data (single-user export — every file has exactly one `user_id`, `21325068`). All figures below (row counts, overlaps) are specific to this export.

## 1. How to read this document

- §2 is the full file inventory — every file, its row/column count, and its columns.
- §3 groups files by what they're for and picks a source of truth per MyTv V1 feature.
- §4 is the sensitive-data findings — read this before anyone touches an importer.
- §5 is a key structural finding that affects the schema proposal (no episode metadata in the export).
- §6 proposes a normalized MyTv V1 schema (**not applied** — Prisma schema is untouched).
- §7 proposes an importer strategy (**not implemented**).

## 2. Full file inventory

| File | Rows | Cols | Columns |
| --- | --- | --- | --- |
| `_appsflyer_ids.csv` | 1 | 4 | `updated_at`, `user_id`, `appsflyer_device_id`, `created_at` |
| `access_token.csv` | 1 | 7 | `id`, `user_id`, `app_id`, `access_token`, `created_at`, `updated_at`, `cpt` |
| `ad_campaign_view.csv` | 2 | 6 | `user_id`, `campaign_id`, `view_count`, `last_view_time`, `created_at`, `updated_at` |
| `ad_identifier.csv` | 2 | 5 | `user_id`, `ad_id`, `id_type`, `created_at`, `updated_at` |
| `auth-prod-login.csv` | 6 | 12 | `reset_token`, `range_key`, `valid_until`, `user_id`, `hash_key`, `email`, `username`, `password_hash`, `encrypted_secret`, `external_id`, `provider`, `encrypted_token` |
| `comment_translation.csv` | 24 | 10 | `translation`, `updated_at`, `user_id`, `confidence`, `source_lang`, `comment_id`, `dest_lang`, `created_at`, `rule_used`, `comment_type` |
| `comments-prod-comments.csv` | 760 | 10 | `entity_uuid`, `created_at`, `sort_key`, `comment_uuid`, `type`, `user_id`, `movie_name`, `last_read`, `expires_at`, `series_name` |
| `device_data.csv` | 24 | 6 | `created_at`, `updated_at`, `id`, `device_id`, `name`, `value` |
| `device_token.csv` | 3 | 10 | `id`, `device_token`, `created_at`, `app_version`, `version_code`, `user_id`, `updated_at`, `device`, `parse_installation_id`, `fcm_registration_token` |
| `emotions-3-prod-episode_votes.csv` | 3343 | 6 | `season_number`, `episode_number`, `user_id`, `vote_key`, `episode_id`, `series_name` |
| `emotions-live-votes.csv` | 180 | 5 | `vote_key`, `episode_id`, `user_id`, `movie_name`, `uuid` |
| `emotions-v2-prod-votes.csv` | 1167 | 8 | `user_id`, `vote_key`, `episode_id`, `movie_name`, `uuid`, `series_name`, `season_number`, `episode_number` |
| `episode_comment.csv` | 20 | 24 | `unappropriate_count`, `highlight_level`, `extended_comment`, `source`, `tv_show_name`, `id`, `user_id`, `posted_on_twitter`, `updated_at`, `lang`, `depth`, `nb_likes`, `parent_comment_id`, `comment_type`, `same_ip_likes`, `comment`, `created_at`, `posted_on_fb`, `nb_points`, `episode_season_number`, `episode_number`, `episode_id`, `spoiler_count`, `valid` |
| `episode_comment_like.csv` | 517 | 5 | `user_id`, `episode_comment_id`, `created_at`, `updated_at`, `source` |
| `episode_comments_last_read_date.csv` | 111 | 8 | `created_at`, `updated_at`, `tv_show_name`, `episode_season_number`, `episode_number`, `user_id`, `episode_id`, `last_comment_read_date` |
| `episode_emotion.csv` | 474 | 8 | `user_id`, `episode_id`, `emotion_id`, `created_at`, `updated_at`, `tv_show_name`, `episode_season_number`, `episode_number` |
| `followed_tv_show.csv` | 361 | 11 | `user_id`, `updated_at`, `archived`, `notification_offset`, `tv_show_name`, `tv_show_id`, `created_at`, `active`, `diffusion`, `notification_type`, `folder_id` |
| `followed_tv_show_source.csv` | 51 | 6 | `tv_show_id`, `source`, `created_at`, `updated_at`, `tv_show_name`, `user_id` |
| `friend.csv` | 18 | 5 | `user_id`, `friend_id`, `created_at`, `updated_at`, `affinity` |
| `gdpr_requests.csv` | 1 | 9 | `source`, `created_at`, `data_generated`, `locked`, `s3_key`, `id`, `user_id`, `updated_at`, `error_message` |
| `install_tracking.csv` | 6 | 7 | `name`, `value`, `created_at`, `updated_at`, `id`, `user_id`, `source` |
| `installed_app.csv` | 9 | 6 | `user_id`, `device_id`, `app_id`, `removed`, `created_at`, `updated_at` |
| `ip_address.csv` | 1290 | 13 | `country_name`, `zip_code`, `longitude`, `user_id`, `hits`, `updated_at`, `country_code`, `city_name`, `latitude`, `timezone`, `region_name`, `created_at`, `ip_address` |
| `lists-prod-lists.csv` | 4 | 12 | `lists`, `user_id`, `s_key`, `list_count`, `name`, `objects`, `type`, `created_at`, `description`, `is_public`, `updated_at`, `ordering` |
| `meme.csv` | 15 | 24 | `clean_version_url`, `gif_small_url`, `has_captions`, `meme_id`, `width`, `url`, `small_url`, `created_at`, `id`, `external`, `blurred_version_url`, `captions`, `gif_url`, `gif_medium_url`, `updated_at`, `height`, `medium_url`, `clean_version_medium_url`, `has_drawing`, `has_stickers`, `episode_comment_id`, `clean_version_small_url`, `signature`, `type` |
| `notifications-prod-notifications.csv` | 229 | 19 | `data`, `date`, `image`, `time`, `read`, `is_read`, `user_id`, `url`, `type`, `objects`, `badge_name`, `object_type`, `object_id`, `badge`, `html_text`, `title`, `text`, `sound`, `web_url` |
| `ratings-3-prod-episode_votes.csv` | 1853 | 6 | `user_id`, `episode_id`, `vote_key`, `series_name`, `season_number`, `episode_number` |
| `ratings-live-votes.csv` | 156 | 5 | `episode_id`, `user_id`, `vote_key`, `uuid`, `movie_name` |
| `ratings-prod-episode_votes.csv` | 721 | 6 | `episode_number`, `vote_key`, `user_id`, `episode_id`, `series_name`, `season_number` |
| `ratings-v2-prod-votes.csv` | 634 | 8 | `vote_key`, `episode_id`, `uuid`, `user_id`, `movie_name`, `series_name`, `season_number`, `episode_number` |
| `recommendations-prod-user-scores.csv` | 1 | 4 | `tv_shows`, `user_mean`, `user_id`, `user_variance` |
| `recommendations-prod-user-shows.csv` | 1 | 2 | `user_id`, `watched_show_ids` |
| `refresh_token.csv` | 3 | 6 | `blacklisted`, `created_at`, `updated_at`, `user_id`, `device_id`, `token` |
| `rewatched_episode.csv` | 1465 | 8 | `tv_show_name`, `episode_season_number`, `episode_number`, `user_id`, `episode_id`, `cpt`, `created_at`, `updated_at` |
| `seen_episode_latest.csv` | 46 | 7 | `updated_at`, `tv_show_name`, `episode_season_number`, `episode_number`, `user_id`, `episode_id`, `created_at` |
| `seen_episode_source.csv` | 681 | 8 | `episode_id`, `source`, `created_at`, `updated_at`, `tv_show_name`, `episode_season_number`, `episode_number`, `user_id` |
| `show_addiction_score.csv` | 264 | 7 | `user_id`, `tv_show_id`, `last_action_timestamp`, `daily_score`, `weekly_score`, `monthly_score`, `tv_show_name` |
| `show_character_episode_vote.csv` | 1656 | 9 | `updated_at`, `tv_show_name`, `episode_number`, `user_id`, `show_character_id`, `fb_action_id`, `episode_season_number`, `episode_id`, `created_at` |
| `show_seen_episode_latest.csv` | 265 | 6 | `tv_show_id`, `episode_id`, `created_at`, `updated_at`, `tv_show_name`, `user_id` |
| `similar_show_suggestion.csv` | 14 | 7 | `tv_show_id`, `similar_show_id`, `created_at`, `updated_at`, `reason`, `tv_show_name`, `user_id` |
| `stats-prod-cache.csv` | 4 | 8 | `stats`, `version`, `user_id`, `entity_type`, `timestamp`, `stat_type`, `type`, `interaction_type` |
| `tracking-deployment-prod-tracks.csv` | 1 | 3 | `user_id`, `created_at`, `day` |
| `tracking-prod-count-by-timeframe.csv` | 77 | 5 | `expires_at`, `runtime`, `user_id`, `type`, `count` |
| `tracking-prod-records-v2.csv` | 24009 | 29 | `gsi`, `created_at`, `key`, `series_name`, `runtime`, `s_no`, `ep_no`, `user_id`, `bulk_type`, `season_number`, `episode_number`, `s_id`, `ep_id`, `episode_id`, `total_series_runtime`, `total_movies_runtime`, `series_follow_count`, `movie_watch_count`, `updated_at`, `ep_watch_count`, `is_followed`, `is_for_later`, `most_recent_ep_watched`, `is_archived`, `uuid`, `followed_at`, `is_unitary`, `rewatch_count`, `is_special` |
| `tracking-prod-records.csv` | 4135 | 30 | `type`, `watch_count`, `uuid`, `series_name`, `type-uuid-n`, `user_id`, `created_at`, `series_id`, `updated_at`, `watches`, `release_date`, `follow_date_range_key`, `release_date_range_key`, `movie_name`, `entity_type`, `runtime`, `alpha_range_key`, `rewatch_count`, `episode_number`, `season_number`, `watch_date`, `episode_id`, `series_uuid`, `total_series_runtime`, `total_movies_runtime`, `bulk_type`, `country`, `watch_date_range_key`, `watched_episode_range_key`, `unitarian` |
| `tv_show_rate.csv` | 5 | 6 | `user_id`, `tv_show_id`, `rating`, `created_at`, `updated_at`, `tv_show_name` |
| `tv_show_user_emotion_count.csv` | 257 | 7 | `created_at`, `updated_at`, `tv_show_name`, `tv_show_id`, `user_id`, `emotion_id`, `count` |
| `user.csv` | 1 | 48 | *(account profile + settings + OAuth tokens — see §4)* |
| `user_badge.csv` | 526 | 4 | `badge_id`, `created_at`, `updated_at`, `user_id` |
| `user_connection.csv` | 2869 | 5 | `user_id`, `date`, `created_at`, `updated_at`, `source` |
| `user_custom_show_image.csv` | 1 | 7 | `tv_show_name`, `user_id`, `tv_show_id`, `poster_id`, `fanart_id`, `created_at`, `updated_at` |
| `user_device.csv` | 4 | 5 | `user_id`, `device_id`, `version_code`, `created_at`, `updated_at` |
| `user_facebook_data.csv` | 1 | 10 | `user_id`, `gender`, `created_at`, `birthday`, `location`, `facebook_id`, `name`, `username`, `timezone`, `updated_at` |
| `user_facebook_like.csv` | 183 | 6 | `created_at`, `updated_at`, `user_id`, `category`, `name`, `object_id` |
| `user_last_updated.csv` | 1 | 4 | `user_id`, `last_updated`, `created_at`, `updated_at` |
| `user_leaderboard.csv` | 13 | 5 | `score`, `created_at`, `updated_at`, `user_id`, `leaderboard_id` |
| `user_mail_sent_status.csv` | 1 | 11 | `sent_2months_inactive`, `created_at`, `updated_at`, `sent_unfinished`, `sent_last_chance`, `user_id`, `sent_welcome_mail`, `sent_2weeks_inactive`, `sent_discover`, `last_weekly`, `sent_active` |
| `user_object_last_action_date.csv` | 41 | 7 | `object_type`, `object_id`, `action`, `last_action_date`, `created_at`, `updated_at`, `user_id` |
| `user_personal_data.csv` | 4 | 6 | `id`, `user_id`, `name`, `value`, `created_at`, `updated_at` |
| `user_platform.csv` | 1 | 8 | `ipad_cnt`, `android_cnt`, `web_cnt`, `created_at`, `updated_at`, `user_id`, `registered_on`, `iphone_cnt` |
| `user_poll.csv` | 142 | 6 | `user_id`, `poll_id`, `poll_choice_id`, `lang_taken`, `created_at`, `updated_at` |
| `user_quiz.csv` | 46 | 11 | `score`, `result_image_url`, `teammate_id`, `question_group`, `lang_taken`, `user_id`, `finished`, `updated_at`, `avg_time`, `quiz_id`, `created_at` |
| `user_quiz_answer.csv` | 434 | 7 | `score`, `created_at`, `updated_at`, `time`, `user_id`, `quiz_question_id`, `quiz_question_answer_id` |
| `user_session.csv` | 56 | 10 | `platform`, `source`, `medium`, `id`, `user_id`, `deeplink`, `created_at`, `updated_at`, `campaign`, `content` |
| `user_setting.csv` | 41 | 6 | `value`, `created_at`, `updated_at`, `id`, `user_id`, `name` |
| `user_show_special_status.csv` | 29 | 6 | `updated_at`, `tv_show_name`, `user_id`, `tv_show_id`, `status`, `created_at` |
| `user_social_data.csv` | 1 | 8 | `picture_url`, `created_at`, `updated_at`, `image_id`, `gender`, `birthday`, `user_id`, `screen_name` |
| `user_statistics.csv` | 1 | 13 | `nb_friends`, `updated_at`, `nb_episodes_watched`, `nb_memes`, `nb_likes`, `user_id`, `time_spent`, `created_at`, `nb_comments`, `nb_reviews`, `score`, `id`, `nb_shows_followed` |
| `user_tv_show_data.csv` | 489 | 6 | `user_id`, `tv_show_id`, `is_followed`, `is_favorited`, `nb_episodes_seen`, `tv_show_name` |
| `watched_on_episode.csv` | 1260 | 8 | `episode_season_number`, `episode_number`, `user_id`, `episode_id`, `watched_on_source_id`, `created_at`, `updated_at`, `tv_show_name` |
| `webhook_data.csv` | 2 | 8 | `id`, `source`, `external_id`, `data_received`, `created_at`, `updated_at`, `data_processed`, `user_id` |
| `where-to-watch-prod-table.csv` | 441 | 12 | `created_at`, `type`, `vote_type`, `episode_id`, `id`, `user_id`, `network_platform`, `hash_key`, `range_key`, `season_number`, `series_name`, `episode_number` |

`user.csv`'s 48 columns are listed in full in §4 (sensitive-fields section) rather than here, to avoid two copies of a field list that's mostly about what to *exclude*.

## 3. Files grouped by purpose, with source-of-truth calls

### 3.1 Watched episodes + watch dates (core V1 feature)

| File | Rows | What it is |
| --- | --- | --- |
| **`tracking-prod-records-v2.csv`** | 24,009 | **Primary candidate.** A single wide event-log table. Rows are distinguished by a `key` prefix: `watch-episode-*` (19,117 rows — one per episode watch), `rewatch-episode-*` (4,457 rows — one per rewatch), and `user-series-*` (434 rows — a per-series rollup with `is_followed`, `is_for_later`, `is_archived`, `ep_watch_count`, `most_recent_ep_watched`, `followed_at`). `created_at` is the watch timestamp; there's no separate "watch_date" column, so it's unambiguous. Spans 2018-06-08 to 2026-07-02 (i.e. still being written today). |
| `tracking-prod-records.csv` | 4,135 | **Legacy/lower-granularity twin of the above.** Same concept (`type` column: `watch` 3,578 rows, `follow` 413, `count-watch-episode-series` 47, `towatch` 34 [= watchlist adds], `last-episode-watched` 47, `rewatch` 3, etc.), but far fewer watch events than v2 covering the same time range, and a `watch_date` column that's populated on only 288/3,578 (8%) of watch rows — `created_at` is the de facto timestamp here too. Also carries `entity_type` (`episode` vs `movie`, useful for filtering movies out) and `bulk_type: fill-previous` (user retroactively bulk-marked a run of earlier episodes watched in one action — all of those rows share one `created_at`, so the "watch date" for bulk-filled episodes is *when the bulk action happened*, not necessarily when the episode was actually watched — a real data-quality caveat, not a bug). |
| `watched_on_episode.csv` | 1,260 | Simpler episode-watch-event table with a `watched_on_source_id` (device/UI surface, e.g. "web", "iOS", "detail page" — decode via `seen_episode_source.csv`'s `source` values as a hint). Smaller than tracking-v2's watch-episode rows for the same account, so likely an earlier/parallel logging path, not a superset. |
| `rewatched_episode.csv` | 1,465 | Per-episode rewatch counter (`cpt`) with first/last rewatch timestamps. Overlaps conceptually with tracking-v2's `rewatch-episode-*` rows; useful as a cross-check, not a new source. |
| `seen_episode_latest.csv` | 46 | Tiny — looks like a short-lived "recently watched" cache (all rows dated 2026-06-25 to 2026-07-02, i.e. essentially real-time). Not historical, not useful as a bulk import source, but confirms recent activity matches tracking-v2. |
| `show_seen_episode_latest.csv` | 265 | Per-show pointer to the latest episode watched (one row per followed show, not one per episode). Useful later for backfilling `UserSeriesProgress.nextEpisode`-style state, not for the watch history itself. |
| `seen_episode_source.csv` | 681 | Metadata only (`source`: `season-detail` 666, `episode-detail` 15) — which screen the watch action was performed from. Nice-to-have context, not core data. |

**Source of truth: `tracking-prod-records-v2.csv`.** It's the most complete, most current (still being written as of the export date), and lowest-ambiguity (no dual "created_at vs watch_date" problem) table for both watch events and follow/watchlist snapshot state. `tracking-prod-records.csv` should still be imported (into raw tables, per §7) and diffed against v2 to catch any watch events that exist in v1 but weren't carried into v2 — the 118-rating and similar gaps seen elsewhere in this audit suggest migrations weren't always 100% complete.

**Important caveat to carry into the importer:** none of these tables give a clean single boolean for "did the user actually watch this, once, on this date" — `tracking-prod-records-v2.csv` mixes first-watches and rewatches as separate keyed events, and bulk fill-ins collapse many distinct watch dates into one timestamp. The importer's job is to reconstruct one `EpisodeWatch` per (episode, first-watch) and treat rewatch events as informational (V1's `EpisodeWatch` model is unique per user+episode — see §6).

### 3.2 Series/episode identity (join keys — not metadata)

Every watch/rating/emotion/comment file uses the same identity fields: `tv_show_id`/`series_id`/`s_id` (TV Time's internal show id), `series_name`/`tv_show_name`, `episode_id`/`ep_id` (TV Time's internal episode id), `episode_number`/`ep_no`, `season_number`/`s_no` (sometimes `episode_season_number`). These are **TV Time's own internal database IDs** — not TheTVDB, TMDB, or IMDB IDs, and not compatible with MyTv's own `Series`/`Episode` UUIDs. See §5 for why this matters more than it sounds like it should.

### 3.3 Ratings

| File | Rows | Notes |
| --- | --- | --- |
| **`ratings-3-prod-episode_votes.csv`** | 1,853 (1,712 unique episodes) | **Primary candidate for TV episode ratings.** Newest schema naming (`-3-`), clean TV-only columns (`series_name`, `season_number`, `episode_number` always populated), and a superset of `ratings-prod-episode_votes.csv`: 432/550 episode_ids in the older file also appear here. |
| `ratings-prod-episode_votes.csv` | 721 (550 unique episodes) | Legacy. 118 episode_ids exist here but *not* in ratings-3 — likely never migrated. Use as a fallback merge source for those gaps, not as primary. |
| `ratings-v2-prod-votes.csv` | 634 | Mixed schema: has `movie_name` **and** `series_name`/`season_number`/`episode_number` columns, but in the rows sampled, `episode_id` was `0` and only `movie_name` was populated — i.e., in practice this file looks predominantly movie-rating data. Needs a full-file scan (not just sampling) before assuming it's 100% movies, but treat as secondary/movie-leaning. |
| `ratings-live-votes.csv` | 156 | Oldest naming (`-live-`), `uuid`-keyed, `movie_name` only, no series/season/episode columns at all — movie ratings. Out of scope for V1 (§3.6) but must be preserved raw. |
| `tv_show_rate.csv` | 5 | **A different feature entirely**: whole-*series* rating (1–5 scale, e.g. `4.50`), not per-episode. Small (5 rows) but real user data — worth its own field in the normalized schema, separate from episode ratings. |

**Rating value encoding — flagged as needs-review, not resolved here.** All rating/emotion tables encode the vote as a `vote_key` string of the form `{episode_id or uuid}-{user_id}-{value}`, where `value` is the only usable signal (there's no separate numeric rating column). Observed `value` suffixes for the ratings tables range roughly 1–29, which does *not* cleanly match a simple 1–5 or 1–10 scale — TV Time's actual episode rating UI is a 0.5–10 star scale in half-point increments (20 possible values), so values above 20 are unexplained from the CSVs alone. **Do not guess this encoding when building the importer** — either decode it against TV Time's public API/app behavior first, or import the raw `value` untransformed into a raw table and leave the star-scale mapping as a explicit follow-up task (flagged in `needs-review.json`, see §7).

### 3.4 Emotions / reactions

| File | Rows | Notes |
| --- | --- | --- |
| **`emotions-3-prod-episode_votes.csv`** | 3,343 (1,279 unique episodes) | **Primary candidate.** Same `-3-` naming pattern as ratings, and a near-total superset of `emotions-v2-prod-votes.csv` (639/640 episode_ids also present here). |
| `emotions-v2-prod-votes.csv` | 1,167 | Legacy/near-subset of emotions-3 — safe to treat as pure fallback. |
| `emotions-live-votes.csv` | 180 | Oldest schema, movie-only (`movie_name`, no series/season/episode columns) — out of scope for V1, preserve raw. |
| `episode_emotion.csv` | 474 (474 unique episodes) | **Not a duplicate — a separate, mostly non-overlapping schema.** Only 144/474 of its episode_ids also appear in emotions-3 (i.e. 330 episodes' worth of emotion data exists *only* here). Clean columns (`emotion_id` as a plain integer, no vote_key string-parsing needed), and it's the one place emotion data is unambiguous to decode. Likely predates the vote_key-based system and was never fully migrated forward. **Must be merged in, not discarded**, per the "don't lose useful data" requirement. |
| `tv_show_user_emotion_count.csv` | 257 | Per-show aggregate emotion counts — a derived/rollup table, not a source of individual events. Useful only for sanity-checking import completeness (does the sum of imported emotion events per show roughly match this count?). |

**Source of truth: union of `emotions-3-prod-episode_votes.csv` and `episode_emotion.csv`**, deduplicated where both cover the same episode (emotions-3 wins on conflict, since it's the more current/complete of the two vote_key-based tables). `emotions-v2-prod-votes.csv` and `emotions-live-votes.csv` are legacy/movie inputs, not needed for the merge but preserved raw.

Same value-encoding caveat as ratings: `emotion_id`/vote_key suffix values (observed range ~13–39) look like an enum of TV Time's reaction icons (love / laugh / shock / cry / etc.), not a numeric scale — needs a lookup table that doesn't exist in this export. Flag for `needs-review.json`.

### 3.5 Comments / notes

| File | Rows | Notes |
| --- | --- | --- |
| **`episode_comment.csv`** | 20 | **Only file with actual comment text** (`comment` field), tied to `tv_show_name` + `episode_season_number` + `episode_number` + `episode_id`. This is the closest analog to MyTv's private per-watch note — but it's structurally a **public/social comment**: it carries `nb_likes`, `nb_points`, `posted_on_twitter`/`posted_on_fb`, `spoiler_count`, `highlight_level`, `same_ip_likes`. TV Time has no concept of a private note; this table is the only candidate and importing it as `EpisodeNote.text` is a reasonable mapping, but the social metadata (likes, spoiler flags, twitter/fb cross-post flags) has no home in MyTv's schema and should go to raw metadata (§6/§7), not be silently dropped or silently misrepresented as a "private" note. |
| `comments-prod-comments.csv` | 760 | **Not comment text** — an interaction/activity log (`type`: mostly `like`), i.e. "user liked comment X". No `comment` text field at all. Not needed for the notes feature. |
| `episode_comment_like.csv` | 517 | Likes on comments — social feature, out of scope for V1. |
| `comment_translation.csv` | 24 | Auto-translations of comment text — out of scope. |
| `episode_comments_last_read_date.csv` | 111 | UI read-state (which comment threads the user has seen) — out of scope. |

**Source of truth: `episode_comment.csv`** for the 20 rows that exist. This is a small dataset (only 20 comments across this user's whole history), so its import impact is minor but should still be done correctly and flagged for user review before treating as "private" (`needs-review.json`).

### 3.6 Watchlist / follow / lists

| File | Rows | Notes |
| --- | --- | --- |
| `user_show_special_status.csv` | 29 | Clean, purpose-built status table: `status` is `for_later` (23 rows — this is the watchlist) or `favorite` (6 rows — a separate, out-of-V1-scope favoriting feature). Directly maps to `WatchlistItem`. |
| `followed_tv_show.csv` | 361 | "Follow/track this show" — `active` (308 active / 53 inactive) and `archived` (36 archived) flags, plus `created_at` as a clean follow date. Broader concept than "watchlist" (following ≠ wanting to watch — it's closer to "subscribed for notifications"), but overlaps with it in practice. |
| `tracking-prod-records-v2.csv` (`user-series-*` rows) | 434 | Also carries `is_followed`, `is_for_later`, `is_archived`, `followed_at` per show — the freshest snapshot (most recently updated of the three), since it's part of the actively-written v2 table. |
| `lists-prod-lists.csv` | 4 | Custom user lists ("Favorite Shows", "Favorite Movies", plus a `count` metadata row). The list contents are a **Go map literal serialized as a string** (not JSON — e.g. `map[created_at:... name:Favorite Shows ...]`), which needs a dedicated parser, not a CSV/JSON reader. Real data, low row count, out of scope for V1's watchlist feature specifically but shouldn't be discarded. |
| `user_tv_show_data.csv` | 489 | Another derived summary (`is_followed`, `is_favorited`, `nb_episodes_seen` per show) — useful for cross-validation, not a primary source. |

**Source of truth: `user_show_special_status.csv` (`status = for_later`) as the primary watchlist signal**, reconciled against `tracking-prod-records-v2.csv`'s `is_for_later` flag (freshest) if they disagree — recommend "most recently updated wins" as the tie-break rule, logged to `needs-review.json` when a genuine conflict is found (not silently resolved).

### 3.7 Movies (out of scope for V1, must not be lost)

Movie data isn't in its own file — it's interleaved into the same tables as TV data, distinguished by `entity_type = 'movie'` (`tracking-prod-records.csv`), or by `episode_id = '0'` with `movie_name` populated and `series_name` empty (`ratings-live-votes.csv`, `ratings-v2-prod-votes.csv`, `emotions-live-votes.csv`, `emotions-v2-prod-votes.csv`), or by presence in `comments-prod-comments.csv`'s `movie_name` column. `recommendations-prod-user-shows.csv` and `similar_show_suggestion.csv` are also movie/show-recommendation-adjacent and out of scope.

**Handling: import all of it into raw tables untouched (§7), tag `entity_type = 'movie'` rows and `episode_id = '0'` rows explicitly during raw ingestion, and simply never surface them in the normalized V1 tables.** Nothing needs to be filtered out of the *files*; filtering happens at the raw→normalized transform step, and the raw copy means movie data can be normalized later without re-exporting anything.

### 3.8 Not relevant to MyTv's product (social/gamification/telemetry/infra) — import raw, no normalized mapping

`friend.csv`, `user_badge.csv`, `user_leaderboard.csv`, `user_poll.csv`, `user_quiz.csv`, `user_quiz_answer.csv`, `meme.csv`, `show_character_episode_vote.csv`, `user_facebook_like.csv`, `notifications-prod-notifications.csv`, `stats-prod-cache.csv`, `show_addiction_score.csv`, `tracking-deployment-prod-tracks.csv`, `tracking-prod-count-by-timeframe.csv`, `install_tracking.csv`, `installed_app.csv`, `ad_campaign_view.csv`, `user_session.csv`, `user_connection.csv`, `user_object_last_action_date.csv`, `user_last_updated.csv`, `user_platform.csv`, `similar_show_suggestion.csv`, `where-to-watch-prod-table.csv`, `webhook_data.csv`, `followed_tv_show_source.csv`, `device_data.csv`, `user_setting.csv`, `user_custom_show_image.csv`, `user_statistics.csv`, `gdpr_requests.csv`, `recommendations-prod-user-scores.csv`, `recommendations-prod-user-shows.csv`.

These have no MyTv V1 feature to map to. Per requirement 10/13, they still get imported into raw tables (nothing is discarded), just with no normalized-table transform written for them yet.

## 4. Sensitive / private fields — must never be imported into normalized tables or logged

A full header sweep for auth/credential/PII-shaped field names found real, populated sensitive data (not just column names) in the following files. **This is real personal data belonging to the export owner** (confirmed by inspecting values, not just headers) — it must be excluded from any importer output, debug logs, error messages, or committed fixtures.

| File | Sensitive fields | Notes |
| --- | --- | --- |
| **`auth-prod-login.csv`** | `email`, `password_hash`, `encrypted_secret`, `encrypted_token`, `reset_token`, `hash_key` | Password-reset flow history. `password_hash`/`encrypted_secret` were empty in the sampled rows but the *columns* must still be denylisted unconditionally — don't rely on current emptiness. |
| **`user.csv`** | `mail`, `password`, `password_new` (bcrypt hash — populated), `fb_access_token` (populated, a live-looking Facebook token), `twitter_oauth_token`, `twitter_oauth_token_secret`, `tumblr_oauth_token`, `tumblr_oauth_token_secret`, `facebook_id`, `twitter_id`, `tumblr_id`, `device_token`, `hash` | The single-row account profile. Contains a real email address and what looks like a live OAuth access token. Highest-sensitivity file in the export. |
| `access_token.csv`, `refresh_token.csv`, `device_token.csv` | `access_token`, `token`, `device_token`, `fcm_registration_token` | Session/push credentials. |
| `webhook_data.csv` | `external_id`, `data_received`/`data_processed` (opaque payload — inspect before assuming safe) | |
| `ip_address.csv` | `ip_address`, plus derived geolocation (`city_name`, `latitude`/`longitude`, `zip_code`, `region_name`, `country_name`) | 1,290 rows — a full IP/location history. |
| `user_facebook_data.csv`, `user_social_data.csv` | `birthday`, `gender`, `location`, `name`, `username`, `picture_url`, `facebook_id`, `screen_name` | Third-party profile PII. |
| `user_facebook_like.csv` | Facebook page/category likes tied to the user | Behavioral PII from a linked account. |
| `show_character_episode_vote.csv` | `fb_action_id` | Minor — a Facebook Open Graph action id, not personal data itself, but still a foreign-system identifier; exclude out of caution. |
| `_appsflyer_ids.csv`, `ad_identifier.csv` | `appsflyer_device_id`, `ad_id` | Advertising/attribution identifiers — marketing-only, no product value, exclude. |
| `device_data.csv`, `installed_app.csv`, `user_device.csv` | `device_id` (repeated across files) | Device fingerprinting data — low direct sensitivity but exclude as a general device-identifier policy. |
| `user_personal_data.csv` | `country-code`, `bio` (as `name`/`value` pairs) | Low sensitivity but still user-provided profile data; exclude by default, could be revisited later as an opt-in profile import. |
| `gdpr_requests.csv` | Entire file | Meta-record of the user's own GDPR export/delete requests — not useful to MyTv and arguably shouldn't be duplicated into another system at all. |

**Recommended blanket policy for the importer** (detailed in §7): treat `auth-prod-login.csv`, `access_token.csv`, `refresh_token.csv`, `device_token.csv`, `user.csv`, `user_facebook_data.csv`, `user_social_data.csv`, `user_facebook_like.csv`, `ip_address.csv`, `webhook_data.csv`, `_appsflyer_ids.csv`, `ad_identifier.csv`, `gdpr_requests.csv` as **excluded from raw import entirely** (not even into raw tables) — these files have no product purpose and keeping them anywhere in MyTv's database only creates a second place a credential leak or PII breach could happen. For files that mix a few sensitive columns with useful ones (there weren't any found in this export — the sensitive-heavy files above are uniformly sensitive), the fallback rule is: import the file raw but drop the specific sensitive column(s), and record what was dropped in `skipped-sensitive-fields.json`.

## 5. Key structural finding: no episode/series metadata in this export

A header sweep for `title`, `overview`, `air_date`, `poster`, `synopsis`, `description`, `runtime` (episode-level) found **no episode titles, overviews, air dates, or poster images anywhere in the export.** The only "metadata" present is:
- `series_name` / `tv_show_name` (free text show name, as the user's client displayed it at watch time)
- `season_number` / `episode_number` (numeric position)
- `runtime` at the watch-event level (minutes, e.g. `tracking-prod-records-v2.csv`'s `runtime` — appears to be the show's typical episode runtime, not per-episode)
- `tv_show_id` / `episode_id` — TV Time's own internal DB ids, not TheTVDB/TMDB/IMDB ids, and not resolvable to real metadata without TV Time's (private) catalog API

**Consequence for the importer:** MyTv's `Series`/`Episode` records can be *identified* from this export (by name + season number + episode number), but cannot be *populated* with `overview`, `posterUrl`, or `airDate` from it — those fields will be `null` until the future Trakt integration backfills them by matching on `(series title, season, episode)`. The importer should create Series/Season/Episode rows with only the fields this export actually supports, and leave metadata fields empty rather than inventing placeholder content.

## 6. Proposed normalized MyTv schema for V1 (proposal only — not applied)

This maps onto the **existing** Prisma models (`User`, `Series`, `Season`, `Episode`, `UserSeriesProgress`, `EpisodeWatch`, `EpisodeNote`, `WatchlistItem`, `ExternalIds`) with no structural changes required for V1 import, plus one new field suggestion:

| MyTv model | Populated from | Notes |
| --- | --- | --- |
| `User` | N/A — the existing dev user, or a real account once auth exists | The importer attaches all imported rows to one target `userId` passed in as a parameter; it does not create users from `user.csv` (which is excluded per §4 anyway). |
| `Series` | Distinct `(series_name)` values across `tracking-prod-records-v2.csv`, ratings, emotions | `title` = `series_name` as-is (no fuzzy-cleanup in V1 — e.g. don't try to strip "(2014)" suffixes automatically; flag ambiguous-looking names in `needs-review.json` instead). `overview`/`posterUrl` left `null` (§5). `status` defaults to `ONGOING` (unknown from this data — also a `needs-review` candidate if it matters). |
| `Season` | Distinct `(series, season_number)` pairs | |
| `Episode` | Distinct `(series, season_number, episode_number)` triples | `title` left as a placeholder (e.g. `"Episode {n}"`) or `null` — **not** invented. `airDate`/`overview`/`runtimeMinutes` left `null` except `runtimeMinutes`, which can come from the watch-event `runtime` field if it's confirmed to be per-episode (needs validation — flag). |
| `EpisodeWatch` | `tracking-prod-records-v2.csv` `watch-episode-*` rows (first watch per episode) | `watchedAt` = `created_at`. One `EpisodeWatch` per (user, episode) per MyTv's existing unique constraint — if TV Time shows multiple watch events for the same episode (a genuine rewatch), only the **earliest** is imported as the canonical `EpisodeWatch.watchedAt` for V1 (MyTv doesn't model rewatch history yet), and the rest are preserved in raw tables + surfaced as a rewatch count in raw metadata, not lost. |
| `UserSeriesProgress` | Derived, not imported directly | Computed the same way the app already computes it today (per episode-watch backfill): `lastWatchedAt` = latest `EpisodeWatch.watchedAt` for the series, `nextEpisodeId` computed with the existing "next episode in sequence" logic, `status` = `COMPLETED` if every known episode is watched, else `WATCHING`. |
| `EpisodeNote` | `episode_comment.csv` `comment` field | One row per imported comment, matched to the `EpisodeWatch` for that episode if one exists (comments with no matching watch event go to `needs-review.json`, since MyTv's `EpisodeNote` is scoped to a watch, not to an episode directly). Social metadata (likes, spoiler flag, fb/twitter cross-post flags) is **not** dropped — stored under raw metadata (see below), not mapped to a MyTv field. |
| `WatchlistItem` | `user_show_special_status.csv` (`status = for_later`), reconciled with `tracking-prod-records-v2.csv`'s `is_for_later` | `addedAt` = `created_at` from the status table. |
| `ExternalIds` | Not populated from this export | TV Time's internal `tv_show_id`/`episode_id` don't map to `traktId`/`tmdbId`/`imdbId`. Proposal: **add a `tvtimeShowId/tvtimeEpisodeId` pair to raw metadata (not to `ExternalIds`, which is Trakt/TMDB/IMDB-specific) so a re-import or future cross-reference is still possible** without a schema change today. |

**Movies**: not mapped to any normalized table in V1 (`Series`/`Episode` are TV-only per the existing schema and product scope). Preserved entirely in raw tables (§7).

## 7. Proposed importer strategy (proposal only — not implemented)

### 7.1 Raw import layer

One raw table per **imported** source file (i.e. every file *except* the excluded-sensitive list in §4), schema-mirrored 1:1 to the CSV (all columns as text/nullable, no type coercion, no dropped columns beyond the sensitive-field denylist). Purpose: never lose data, never re-parse the CSVs twice, and give `needs-review.json` something concrete to point back to (`raw table + row id`). Suggested naming: `raw_tvtime_<file_stem>` (e.g. `raw_tvtime_tracking_prod_records_v2`), loaded via a one-off script, not part of the app's runtime schema — these are import scratch tables, likely in a separate schema/database or clearly namespaced, not mixed into MyTv's product tables.

Each raw row gets an `import_batch_id` (so re-running the importer against a newer export doesn't collide with a previous run) and a `source_file` + `source_row_number` for traceability.

### 7.2 Normalized transform layer

A second pass reads from the raw tables (never re-parses CSVs) and writes into MyTv's real Prisma tables per the §6 mapping. This pass is the only place business logic (dedup, "earliest watch wins", next-episode computation) lives, and it should be fully re-runnable/idempotent (safe to run twice against the same raw data without creating duplicate `Series`/`Episode`/`EpisodeWatch` rows) — matching the same upsert-by-natural-key approach the app already uses elsewhere (e.g. `EpisodeWatch` unique on `userId+episodeId`).

### 7.3 Deduplication

- **Series identity**: dedupe by exact `series_name` match across source files first (case-sensitive, as-is). Fuzzy/near-duplicate names (e.g. trailing whitespace, differing punctuation) go to `needs-review.json` rather than being auto-merged — auto-merging show identities silently is exactly the kind of mistake that's expensive to undo later.
- **Episode watch events**: within `tracking-prod-records-v2.csv`, and across it vs. `tracking-prod-records.csv`/`watched_on_episode.csv`, dedupe on `(series, season_number, episode_number)` — keep the **earliest** `created_at` as the canonical watch date, record the rest as rewatch/duplicate-source evidence in raw metadata.
- **Ratings**: `ratings-3-prod-episode_votes.csv` wins on conflict; fall back to `ratings-prod-episode_votes.csv` only for episodes absent from ratings-3.
- **Emotions**: union of `emotions-3-prod-episode_votes.csv` and `episode_emotion.csv`; emotions-3 wins on conflict (§3.4).
- **Watchlist**: `user_show_special_status.csv` wins; `tracking-prod-records-v2.csv`'s `is_for_later` used as a freshness check, conflicts logged not auto-resolved (§3.6).

### 7.4 Validation

Before writing to normalized tables, validate per row:
- Required identity fields present (`series_name` or resolvable show id; `season_number`/`episode_number` are non-negative integers).
- Timestamps parse to valid dates and aren't in the future relative to the export date.
- `user_id` matches the single expected TV Time account id for this import run (a stray row from a different account would indicate export corruption).
- Cross-file consistency spot checks: does the count of imported `EpisodeWatch` rows per series roughly match `tracking-prod-records-v2.csv`'s own `ep_watch_count` for that series? Large mismatches go to `needs-review.json`, not silently accepted.

Rows failing validation are **skipped from the normalized layer** (they still exist in the raw layer) and recorded in `needs-review.json` with a reason.

### 7.5 Output artifacts

- **`import-report.json`** — summary counts: rows read per source file, rows written per normalized table, rows skipped (sensitive/excluded files, by file), rows deduplicated (with counts per dedup rule in §7.3), start/end timestamps, import_batch_id.
- **`needs-review.json`** — every row/decision that couldn't be resolved automatically: ambiguous series-name near-duplicates, watchlist conflicts between sources, comments with no matching watch event, cross-file count mismatches, and the unresolved rating/emotion value-encoding question from §3.3/§3.4 (this one's a standing entry, not per-row, until it's decoded).
- **`skipped-sensitive-fields.json`** — a static list (doesn't need to be regenerated per run unless the source files change): every file excluded wholesale under §4, and for any file where only specific columns were dropped, exactly which columns and why. Committed to the repo (not gitignored) as documentation of the policy, since it's a decision record, not the data itself.

### 7.6 Raw metadata for unknown/unmapped-but-useful fields

Per requirement 10: every raw table row that contributes to a normalized row gets its full original row (or the subset not otherwise mapped) preserved under a `rawMetadata` JSON field on the normalized row — e.g. `EpisodeNote.rawMetadata` would carry `episode_comment.csv`'s `nb_likes`, `spoiler_count`, `posted_on_twitter`/`posted_on_fb`, `highlight_level`; `EpisodeWatch.rawMetadata` could carry the `bulk_type`/`source` device info. This requires one new nullable JSON column per relevant model — a small, additive Prisma schema change to make **when the importer is actually built**, not now (requirement 13 — schema untouched in this audit).

## 8. Summary of open questions (candidates for `needs-review.json` policy, not per-row)

1. **Rating/emotion `vote_key` value encoding is not confirmed** (§3.3/§3.4) — needs decoding against TV Time's app/API behavior before ratings can be shown as stars or emotions as icons in MyTv.
2. **`ratings-v2-prod-votes.csv` movie-vs-TV split wasn't fully verified** (only sampled) — needs a full scan before deciding how much of it (if any) is missed TV data.
3. **Bulk `fill-previous` watch events share one timestamp for potentially many episodes** — acceptable for V1 but worth surfacing to the user on import ("some old watch dates are approximate") rather than presenting them as precise.
4. **Series identity is name-based only** — no external ID crosswalk exists in this export, so two shows with the same display name (rare but possible, e.g. reboots) would collide. Low risk for a personal single-account export, but worth a `needs-review` check for exact-duplicate `series_name` values with materially different episode counts.

## Summary

Audited all 72 CSV files under `./tvtime-export/`. Found a clear primary source for each MyTv V1 feature: `tracking-prod-records-v2.csv` for watched episodes/dates and watchlist snapshot, `ratings-3-prod-episode_votes.csv` for ratings, `emotions-3-prod-episode_votes.csv` + `episode_emotion.csv` (union, not a simple pick) for emotions, `episode_comment.csv` for notes, and `user_show_special_status.csv` for the watchlist. Several `-live-`/`-v2-`/`-3-`/`-prod-` file families are legacy duplicates of each other with mostly-but-not-fully overlapping data, so the importer strategy is "merge with a clear winner," not "delete the loser." Two structural findings shape the schema/importer design: the export has **no episode-level metadata** (titles/overviews/air dates/posters) at all, so those fields stay null until Trakt backfills them; and the export contains **real, populated credentials and PII** (a live-looking Facebook OAuth token, password hash, email, IP/geolocation history) in `user.csv`, `auth-prod-login.csv`, and related files, which must be excluded from import entirely, not just filtered at the column level. No importer code was written and the Prisma schema was not modified, per the task constraints.
