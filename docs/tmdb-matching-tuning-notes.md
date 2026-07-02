# TMDb Matching — Scoring/Tier Tuning Notes

Proposal document only. **No scoring weights, thresholds, or `AUTO_MATCH` behavior have been changed.** `tmdb-enrichment/scoring.ts` is untouched by this document — everything below is a menu of options for a future decision, grounded in real output from the latest dry-run report, not a change already made.

## 1. The problem, with real numbers

Inspecting `tmdb-enrichment/output/6d50c377-.../tmdb-needs-review.json` (a 10-series dry run), 9 of 10 series got a confident-looking TMDb match, and **every single one scored exactly 80**:

| Series | titleScore | yearScore | rankRelevanceScore | total |
| --- | --- | --- | --- | --- |
| 07-Ghost | 50 (exact) | 10 (unknown) | 20 (position 0) | 80 |
| 11eyes | 50 (exact) | 10 (unknown) | 20 (position 0) | 80 |
| A Certain Magical Index | 50 (exact) | 10 (unknown) | 20 (position 0) | 80 |
| A Certain Scientific Accelerator | 50 (exact) | 10 (unknown) | 20 (position 0) | 80 |
| A Certain Scientific Railgun | 50 (exact) | 10 (unknown) | 20 (position 0) | 80 |
| A Knight of the Seven Kingdoms | 50 (exact) | 10 (unknown) | 20 (position 0) | 80 |
| A Man on the Inside | 50 (exact) | 10 (unknown) | 20 (position 0) | 80 |
| Accel World | 50 (exact) | 10 (unknown) | 20 (position 0) | 80 |
| Adolescence | 50 (exact) | 10 (unknown) | 20 (position 0) | 80 |

This isn't nine coincidentally-similar matches — it's the scoring formula's structure. `titleScore` maxes at 50 for an exact match, `rankRelevanceScore` maxes at 20 for the top search result, and **`yearScore` can only reach its own max of 30 if MyTv's title carried a year hint** (`docs/status-model-plan.md`'s TV-Time-derivable-subset section: only ~15 of 433 imported titles ever got a `(YYYY)` suffix from TV Time). Without a year hint, `yearScore` is pinned at the neutral value of 10 — so **the single best possible score for a title-only match, no matter how exact or how top-ranked, is 50 + 10 + 20 = 80**. The `AUTO_MATCH` threshold is 85. An exact, unambiguous, first-result match can never cross it unless MyTv happens to know the year — which for the overwhelming majority of imported series, it never will.

Net effect: under the current rule, essentially every exact-title match sourced from TV Time import data is permanently capped at `NEEDS_REVIEW`, regardless of match quality. That's not the threshold doing its job (catching genuinely uncertain matches) — it's the threshold rejecting matches that have no year data available to prove themselves with, which is a data-availability problem, not a confidence problem.

## 2. What's *not* the problem

Worth stating explicitly, since it shapes which fixes are appropriate: nothing here suggests these 9 matches are *wrong*. Titles are exact and distinctive (not generic, not obviously reboot-prone), and the years TMDb returned line up with real, known shows (*Adolescence* 2025 is the actual 4-episode Netflix limited series; *A Knight of the Seven Kingdoms* 2026 is the actual upcoming HBO series). The fix belongs in *what other signals can substitute for a missing year*, not in loosening title-matching itself.

## 3. Proposed alternatives (menu, not a decision)

### 3.1 A parallel structural auto-apply path (recommended direction)

Rather than lowering the numeric threshold for everyone (which would also let through weaker, more ambiguous matches that happen to score above the new lower bar), add a **second, independent path to `AUTO_MATCH`** that doesn't route through the absolute score at all — it fires only when several structural conditions all hold at once:

1. `titleMatchType === 'exact'`
2. `resultPosition === 0` (top search result)
3. No close competing candidate — reuse the existing ambiguity-gap check (currently only evaluated once a candidate already clears 85; this proposes evaluating it independently of score)
4. **Episode-count sanity**: `watchedEpisodeCount <= tmdbTotalEpisodeCount` (already true for all 9 examples — none of them fail the existing post-fetch sanity check)
5. **Fully-caught-up as a strong positive signal**: `watchedEpisodeCount === tmdbTotalEpisodeCount`

Condition 5 is the load-bearing one. A user having watched *exactly* as many episodes as a candidate show has ever aired is strong corroborating evidence independent of title text — it's very unlikely to be a coincidence for the wrong show, especially combined with an exact title match. This is a different, non-textual signal, which is exactly what's missing when year data doesn't exist.

**Applied to the real data:** 7 of the 9 series meet all five conditions (07-Ghost, 11eyes, A Certain Magical Index, A Knight of the Seven Kingdoms, A Man on the Inside, Accel World, Adolescence — all `watched == total`). The other 2 (A Certain Scientific Accelerator at 5/12, A Certain Scientific Railgun at 48/73) **correctly fail condition 5** and would stay in `NEEDS_REVIEW` even under this proposal — they have real unwatched episodes remaining, so "exactly caught up" isn't available as corroboration, and title-plus-position alone still isn't enough. That's the right outcome for those two, not a gap in the proposal.

### 3.2 A weaker variant of 3.1 — sanity-only, no strong-positive requirement

Same as 3.1 but drop condition 5, keeping only `watchedEpisodeCount <= tmdbTotalEpisodeCount`. This would auto-apply all 9 examples, including the two partially-watched ones. **Not recommended over 3.1** — "haven't watched more than exists" is a much weaker signal than "watched exactly what exists"; it's satisfied by nearly any plausible wrong match too (most wrong candidate shows would also have more total episodes than a partially-watched series has consumed). Included here mainly to name it and rule it out with a reason, not as a live option.

### 3.3 Scoring-formula change: an episode-match bonus

Alternative to adding a parallel path: extend the existing formula itself with a fourth signal, e.g. `episodeMatchBonus` worth +15 when `watchedEpisodeCount === tmdbTotalEpisodeCount`, making the ceiling for a no-year exact match 50 + 10 + 20 + 15 = 95 — comfortably over 85 without changing the threshold itself. Functionally similar outcome to 3.1 for these examples, but changes the *meaning* of the score (a single number now conflates "how well does the title match" with "how much watch-history evidence exists"), which makes the existing `reasonBreakdown` harder to read and muddies `titleScore`/`yearScore` as independently-interpretable fields. **3.1's separate-path approach is preferred** for keeping the score breakdown legible; noted here as the alternative it's being chosen over, not dismissed without reason.

### 3.4 Stricter handling for generic titles, remakes, and anime/long-running risk

Whichever of the above is eventually adopted, it should apply *more* cautiously, not uniformly, in three specific situations already partially instrumented in this codebase:

- **Generic titles.** If a search returns *multiple* results that all score `titleScore = 50` (exact match against more than one candidate — not just "close in total score," but literally tied on title text), that's a sign the title alone doesn't disambiguate, independent of how the rest of the formula shakes out. Neither 3.1 nor the current formula currently checks for this specific case (the ambiguity-gap check compares *total* scores, which a tied title-only score could still separate on `rankRelevanceScore` alone) — worth adding as its own guard before any structural auto-apply path ships.
- **Remakes/reboots.** The one signal that would resolve these (year) is exactly the signal missing for most of this dataset — which is *why* 3.1 doesn't rely on it, but also why remakes are the category most likely to slip through a structural path that ignores year entirely. If a future pass adds partial-year signals (e.g. TMDb's `first_air_date` decade, or cross-referencing `external_ids.imdb_id` against any IMDb id MyTv might independently obtain later), remakes are where that would pay off most. Until then: recommend that condition 5 in §3.1 (`watched == total`) is treated as a *required*, not optional, guard specifically because a coincidental episode-count match for a same-titled reboot is far less likely than a coincidental title-only match.
- **Anime/long-running numbering risk.** `detectAnimeNumberingRisk()` already exists and is computed today (currently `false` for all 9 examples — none cross its ≥100-episode threshold, correctly). For any series where it *is* `true`, any structural auto-apply path should require the strict `watched == total` form (§3.1, not §3.2) and probably still fall back to `NEEDS_REVIEW` even then — TV Time/TMDb absolute-vs-season numbering disagreements are exactly the failure mode `docs/tmdb-enrichment-plan.md` §7 already flagged as expected noise for this dataset, and an episode-count coincidence is weaker corroboration when numbering conventions themselves are known to diverge.

## 4. Summary table: what would change under §3.1, using real report data

| Series | Watched/Total | Meets §3.1's 5 conditions? | Stays NEEDS_REVIEW? |
| --- | --- | --- | --- |
| 07-Ghost | 25/25 | Yes | No — would auto-apply |
| 11eyes | 12/12 | Yes | No — would auto-apply |
| A Certain Magical Index | 74/74 | Yes | No — would auto-apply |
| A Certain Scientific Accelerator | 5/12 | No (condition 5 fails) | **Yes, correctly** |
| A Certain Scientific Railgun | 48/73 | No (condition 5 fails) | **Yes, correctly** |
| A Knight of the Seven Kingdoms | 6/6 | Yes | No — would auto-apply |
| A Man on the Inside | 16/16 | Yes | No — would auto-apply |
| Accel World | 24/24 | Yes | No — would auto-apply |
| Adolescence | 4/4 | Yes | No — would auto-apply |

## 5. Open questions

- The ambiguity-gap check in §3.1 condition 3 needs to be re-specified for a score-independent path — right now `decideTier`'s gap check only fires *after* a candidate already clears 85 (`docs/trakt-enrichment-plan.md`/`docs/tmdb-enrichment-plan.md` §3.3's shared tier logic). A structural path bypassing the score entirely needs its own definition of "no close competitor" (e.g. no other candidate also scoring `titleScore = 50`).
- Whether `EpisodeRating`/`EpisodeEmotion`/`SeriesRating` data (already imported from TV Time, not yet used anywhere in matching) could serve as a *third* independent corroborating signal alongside title and episode count, for cases where §3.1's condition 5 doesn't apply cleanly (e.g. a currently-airing show that's plausibly caught-up but TMDb's episode count updates before MyTv's next enrichment run does) — not explored here, flagged for a future pass.
- No proposal here changes how `NO_MATCH` is decided (§3's threshold of 50) — only the `NEEDS_REVIEW` → `AUTO_MATCH` boundary was in scope, per the report finding that motivated this document.

## 6. Explicitly not done in this pass

- No changes to `tmdb-enrichment/scoring.ts` — thresholds, weights, and `decideTier` are exactly as they were.
- No new `AUTO_MATCH` behavior — the 9 series discussed above are still `NEEDS_REVIEW` in the actual pipeline after this document.
- No changes to `trakt-enrichment/` — this document is TMDb-specific since it's grounded in the TMDb dry-run report that motivated it; Trakt's tier logic is untouched and not evaluated here.
- No enrichment applied, no app-facing tables modified.
