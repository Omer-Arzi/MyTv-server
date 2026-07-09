# Provider Confirmation Pipeline — Runbook

Operational guide for `library-health:pipeline`, the single repeatable command that takes a locally-imported series from "human-confirmed provider match" to "applied" with minimal intervention. Written for the push to get off TV Time — this is the workflow to run regularly as more titles get confirmed.

## The workflow, end to end

```
1. Discover candidates      library-health:missing-provider-candidates
                             library-health:provider-confirmation
2. Human confirms identity   edit library-health/provider-confirmation-decisions.json
3. Classify + apply          library-health:pipeline            (dry-run, default)
                             library-health:pipeline-apply       (writes)
```

Step 2 is the one hard gate this pipeline will never automate: **which provider candidate is actually the right show is always a human decision**, recorded in [`provider-confirmation-decisions.json`](../library-health/provider-confirmation-decisions.json). The pipeline classifies and applies only decisions already marked `"decision": "confirm"` there. It never guesses an identity on its own — an ambiguous or wrong-provider match is exactly the kind of mistake that would corrupt watch history, so that step stays manual.

Steps 1–2 are unchanged, existing commands — this runbook is about step 3.

## How to run dry-run (default, safe, no writes)

```bash
npm run library-health:pipeline
```

Or directly:

```bash
npx ts-node library-health/run-provider-confirmation-pipeline.ts
```

This is always safe to run — it never writes to the database or to any provider. It:
- fetches fresh provider data for every `"confirm"` decision in the decisions file,
- re-classifies each one (title/year sanity, catalog comparison, season-0-orphan check, split-episode-tail check),
- prints what it *would* do,
- writes a report to `library-health/output/latest-provider-confirmation-pipeline-report.{json,md}` (plus a timestamped copy under `output/runs/`).

Useful flags (all optional):

| Flag | Meaning |
| --- | --- |
| `--user=<id>` | Target a different user than the dev default |
| `--out=<dir>` | Write reports somewhere other than `library-health/output` |
| `--decisions=<path>` | Use a different decisions file |
| `--max-season-zero-orphans=<n>` | Loosen/tighten the season-0-orphan carve-out (default 1) |

## How to run apply (writes)

```bash
npm run library-health:pipeline-apply
```

Or directly:

```bash
npx ts-node library-health/run-provider-confirmation-pipeline.ts --apply-safe-confirmed
```

Apply mode requires the explicit `--apply-safe-confirmed` flag — bare `--apply` is deliberately not recognized (it prints a note and falls back to dry-run) to avoid an accidental write from muscle memory with other scripts in this repo.

Each qualifying series is applied in its own database transaction. One series failing (a network error, a provider 404, etc.) never rolls back or blocks any other series — it's recorded under `errors` in the report and the run continues.

## What is safe to auto-apply

Only three classifications, defined in [`apply-confirmed-provider-logic.ts`](../library-health/apply-confirmed-provider-logic.ts)'s `SAFE_APPLY_CLASSIFICATIONS` — the single source of truth for this list:

| Classification | Meaning |
| --- | --- |
| `SAFE_TO_APPLY_LATER` | Clean match — no structural risk, no orphaned watch history. |
| `SAFE_WITH_LOCAL_SPECIAL_ORPHAN` | Only blocker is ≤1 benign local season-0 special the provider doesn't track. |
| `SAFE_WITH_SPLIT_EPISODE_TAIL` | Only blocker is a confirmed tail-only split/merged-episode numbering difference (e.g. The Office (US) S4/S6/S7 — see [`split-episode-tail-logic.ts`](../library-health/split-episode-tail-logic.ts)). |

For the latter two, the apply step **backfills matched episodes only** and **preserves every orphan/tail episode untouched** — never deleted, never renumbered, never has its watch history touched. The report lists exactly which episodes were preserved for every applied series.

## What still requires human review

**Never auto-applied, ever:**

- `BLOCKED_RISK` — a real structural mismatch: a mid-season gap, a season that actually shrank on the provider side, or a provider episode with no local counterpart. Applying here risks silently orphaning real watch history.
- `NEEDS_MANUAL_REVIEW`
- `PROVIDER_NOT_FOUND` — the provider ID in the decisions file no longer resolves (check for a stale/wrong ID).
- `LOCAL_SERIES_NOT_FOUND` — the title in the decisions file doesn't match any local series (check for a typo/rename).
- Any title/year sanity failure (candidate looks like the wrong show/remake).

**Never even classified:**

- `"decision": "defer"` or `"decision": "skip"` entries in the decisions file — a human already looked and chose not to confirm yet.
- Local series with **no entry at all** in the decisions file — these show up in the report's `nextManualReviewCandidates` list. Investigate them with `library-health:missing-provider-candidates` and `library-health:provider-confirmation`, then add a decision.

## How to review blockers

1. Run dry-run (`npm run library-health:pipeline`) and open `library-health/output/latest-provider-confirmation-pipeline-report.md`.
2. Check the **Skipped — blocked** section — each entry has the exact reason (season shrink details, orphaned-episode IDs, etc.).
3. For a genuine numbering-convention mismatch that isn't yet a recognized safe pattern, investigate it the way [The Office (US) case was investigated](../library-health/split-episode-tail-logic.ts) — compare local vs. provider episodes season-by-season and determine whether it's a split/merge, a real gap, or bad provider data, before considering whether a new classification carve-out is warranted. Don't force a blocked series through by weakening an existing check.
4. Check the **Next manual-review candidates** section for titles with no confirmed decision yet — these need steps 1–2 of the workflow above, not this pipeline.
5. Check **Errors** for transient failures (rate limits, network) that are worth simply re-running.

## Safety guarantees (apply mode)

- No `Episode` row is ever deleted.
- No `EpisodeWatch` row is ever deleted or has its `watchedAt` overwritten.
- Every unmatched local orphan/tail episode is preserved as-is and reported explicitly.
- Only episode metadata for a matched `(seasonNumber, episodeNumber)` pair is backfilled, and only fields the provider has real data for (never overwrites existing local data with a provider null).
- `ExternalIds` is written only for a series with a human-confirmed `"confirm"` decision and a safe classification.
- `UserSeriesProgress.userStatus` re-reads the *live* status inside the transaction and never overrides a protected status (`DROPPED`/`PAUSED`/`WATCHLIST`).
