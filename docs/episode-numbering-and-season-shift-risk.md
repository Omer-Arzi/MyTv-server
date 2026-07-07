# Episode Numbering / Season-Shift Risk

**Status**: documented risk, not yet handled. No audit or fix implemented. This is a TODO note, not a plan to act on yet.

## 1. Problem

TV Time (our import source), TMDb, and TVmaze frequently **disagree on how a series' episodes are split into seasons and numbered**, even when they agree on the episode content itself. This is not a matching-confidence problem (the title/year match can be perfectly correct) — it's a structural disagreement about *where episode boundaries fall*.

This shows up especially for:
- **Anime** — long-running series are often numbered absolutely by one provider (one "season" containing hundreds of episodes) and split into cours/arcs by another.
- **Remakes and reboots** — a franchise may have multiple distinct provider entries (different years) that a title-only match can't tell apart, compounding any numbering mismatch.
- **Specials** — season 0 / OVA / recap episodes are counted inconsistently (sometimes folded into a season's regular run, sometimes excluded entirely, sometimes numbered as "episode 0").
- **Sequel/continuation seasons** — a "final act" or "part 2" entry sometimes shares a single provider ID with the original series, sometimes has its own.

## 2. Known affected or risky series

**Confirmed during the 2026-07-05 targeted enrichment work** (removed from the safe-apply batch specifically because of this):
- **Jujutsu Kaisen** — MyTv/TV Time splits it into 3 seasons (24 + 23 + 7 = 54 watched episodes); TMDb represents it as **one season with absolute numbering** (59 total). A dry-run apply showed only 24 of our 54 watched episodes would match TMDb's numbering — the other 30 would be orphaned, and TMDb's "episodes 25–59" would be created as new rows that actually duplicate content already watched.

**Flagged by existing audits, not yet resolved**:
- **Rurouni Kenshin** — `POSSIBLE_REMAKE_COLLISION` in the TVmaze secondary-provider audit (multiple adaptations: 1996 anime, 2023 anime remake, live-action films — a numbering mismatch here would compound with picking the wrong entry entirely).
- **One Piece** — `TITLE_MISMATCH` in the TV Time parity audit. Two MyTv rows exist ("One Piece," ~1,157 episodes watched, and "ONE PIECE (2023)," 16 episodes) and is also a duplicate-title-group member (`image-coverage-audit`). The only cached TMDb candidate has just 17 known episodes — clearly belongs to the 2023 live-action entry, not the long-running anime.
- **InuYasha / InuYasha: The Final Act** — `TITLE_MISMATCH` in the TV Time parity audit. Both MyTv rows' cached TMDb candidates point at the *same* TMDb ID, meaning "The Final Act" (a real, separate sequel series) hasn't been distinguished from the original.

**Flagged as `POSSIBLE_ANIME_NUMBERING_MISMATCH`** in the full TVmaze secondary-provider audit (`secondary-provider-audit/output/5453e73f-8c6e-4d81-abea-bacf69ee93ee/tvmaze-match-report.json`) — not yet individually investigated the way Jujutsu Kaisen was:
- Boruto: Naruto Next Generations
- D.Gray-man
- Dragon Ball Kai
- Dragon Ball Super
- Dragon Ball Z
- Dragon Quest: The Adventure of Dai (2020)
- Fairy Tail
- Katekyo Hitman Reborn!
- My Hero Academia
- Naruto
- Yu-Gi-Oh! Arc-V
- Zatch Bell!

**Other duplicate-title-group members** (`image-coverage-audit`, same collision risk as One Piece above, not yet individually checked for numbering mismatch):
- Avatar: The Last Airbender / Avatar: The Last Airbender (2021)
- Doctor Who (2005) / Doctor Who (2023)
- Hunter x Hunter / Hunter x Hunter (2011)
- Ranma ½ / Ranma ½ (2024)

**Important**: Jujutsu Kaisen itself was **not** caught by either existing audit's category system — it scored `BOTH_UNCERTAIN` in the TVmaze audit and `FOUND_WITH_INCOMPLETE_CATALOG` in the TV Time parity audit. Neither category means "season-numbering mismatch." It was only caught by manually inspecting the dry-run's per-episode match count during the targeted-enrichment work. **This means the list above is almost certainly incomplete** — there is currently no automated check that specifically detects this failure mode.

### Newly detected by episode-release-refresh dry run

Unlike every series above (found by manual inspection, or by TVmaze/TV-Time-parity audit categories not specifically built for this problem), the six series below were caught **automatically** — `episode-release-refresh/run-refresh.ts`'s first real dry run (`docs/episode-release-refresh-strategy.md`) compares each actively-tracked series' locally-stored catalog *shape* (season count, per-season episode count, and whether each already-watched episode still has a matching slot) against a fresh live fetch of TMDb's current catalog for the same series. None of these were manually declared risky beforehand; all six tripped the dry run's season-shift guard (`compareSeriesCatalog` in `episode-release-refresh/refresh-logic.ts`) on the very first run, each showing the identical signature: a season present locally either shrank or disappeared entirely in TMDb's response, with multiple already-watched episodes losing their matching provider slot as a result — the same absolute-numbering-vs-per-cour-seasons pattern documented for Jujutsu Kaisen in §2 above, not a one-off.

- **Kaiju No. 8** — locally 2 seasons / 34 episodes; TMDb currently reports `number_of_seasons: 1` / 23 episodes (verified directly against the live TMDb API during this pass). All 11 of season 2's episodes, including several already watched, have no matching slot in TMDb's single-season response.
- **DAN DA DAN** — locally 2 seasons / 36 episodes; TMDb's season 2 is entirely absent from the response, orphaning 12 local season-2 episodes (multiple watched).
- **Shangri-La Frontier** — locally 2 seasons / 75 episodes; TMDb's season 2 (25 local episodes, many watched) has no matching slot.
- **Frieren: Beyond Journey's End** — locally 2 seasons / 48 episodes; TMDb's season 2 (10 local episodes, several watched) is missing from the response.
- **Sket Dance** — locally 2 seasons / 103 episodes; TMDb's season 2 (26 local episodes, many watched) has no matching slot.
- **Tokyo Revengers** — same season-shift signature as the five above (see the dry run's archived report under `episode-release-refresh/output/runs/` for the exact per-episode detail).

These six are recorded in `src/common/stale-series-trust.ts` as `PROVIDER_STRUCTURE_MISMATCH_TITLES` — a third list, distinct from `EPISODE_NUMBERING_RISK_LIST_TITLES` (§5 below, manually curated) and `KNOWN_SEASON_SHIFT_ORPHAN_TITLES` (confirmed only after a real enrichment apply already ran and orphaned watches) — because their provenance is different from both: detected pre-apply, by automated catalog-shape comparison, with no apply ever attempted. `isUntrustedNextEpisodeTitle` treats all three lists identically (excluded from Watch Next/stale-series trust and from `episode-release-refresh`'s eligible-candidate set), so the distinction is about *why* a title is on a list, not about differing runtime behavior.

## 3. Why this is dangerous

- Provider enrichment can create episodes that **look unwatched but are actually duplicates of content the user already watched**, just numbered differently.
- `nextEpisodeId` can end up pointing at one of these duplicate "unwatched" episodes — meaning Watch Next would recommend something the user has already seen.
- Episode/season counts become misleading (inflated totals, wrong "X of Y episodes watched" math) without any error being raised — the enrichment apply completes "successfully" while quietly producing wrong data.
- This is distinct from (and not caught by) the existing safety checks in `tmdb-enrichment/apply-plan-validation.ts` and `single-series-safety.ts`, which only compare watched-count against total-count as single numbers — they can't detect that the counts don't align *positionally*.

## 4. Future solution direction

Not implemented yet. Direction for a future pass:

1. **Build a dedicated duplicate/season-shift audit** (separate from the existing image-coverage, TVmaze secondary-provider, and TV Time parity audits) that, for each candidate series:
   - Compares chronological position (Nth-ever-aired episode) between MyTv's existing catalog and the provider's proposed catalog.
   - Compares episode titles where both sides have one (the most reliable cross-provider signal, per the same reasoning already established in `secondary-provider-audit/tvmaze-compare.ts`'s `computeNextEpisodeComparison`).
   - Compares airDates as a secondary signal.
   - Flags when watched-episode count roughly matches a *prefix* of the provider's catalog under a **different** season/episode numbering than what's stored — the specific pattern that makes Jujutsu Kaisen risky.
2. **Never auto-apply enrichment for a flagged series** without a human confirming the mapping — this must remain a hard gate, the same way `single-series-safety.ts` already hard-refuses close-competitor/anime-risk/data-quality-flagged candidates.
3. **Support an explicit manual mapping**: a way to record "MyTv's (season, episode) X corresponds to provider's (season, episode) Y" per series, so a confirmed remapping can be applied deliberately instead of trusting positional/numeric matching alone.

## 5. Explicit rule until this is handled

**Do not apply TMDb/TVmaze enrichment for the following series until this mapping issue has a real audit and/or manual mapping in place:**
- Jujutsu Kaisen
- Rurouni Kenshin
- One Piece
- InuYasha / InuYasha: The Final Act
- Kaiju No. 8, DAN DA DAN, Shangri-La Frontier, Frieren: Beyond Journey's End, Sket Dance, Tokyo Revengers — see "Newly detected by episode-release-refresh dry run" in §2 above

This list should be treated as a minimum, not exhaustive — any series flagged `POSSIBLE_ANIME_NUMBERING_MISMATCH`, `POSSIBLE_REMAKE_COLLISION`, or appearing in a duplicate-title group (see §2 above) should be treated with the same caution until individually checked. All titles listed here (across every category) are enforced in code via `src/common/stale-series-trust.ts`'s `isUntrustedNextEpisodeTitle` — `EPISODE_NUMBERING_RISK_LIST_TITLES`, `KNOWN_SEASON_SHIFT_ORPHAN_TITLES`, and `PROVIDER_STRUCTURE_MISMATCH_TITLES` together.
