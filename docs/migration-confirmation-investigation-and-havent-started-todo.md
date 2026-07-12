# TODO — Migration Confirmation investigation + "Haven't Started Yet" Home carousel

Live progress tracker for this task. Updated as work proceeds.

## Workstream A — Migration Confirmation failures

- [x] Phase A1: Trace the complete flow (list → proposal → DTO → REST → mobile types → rendering → confirm → apply)
- [x] Phase A2: Audit real examples (Mirai Nikki, Nisekoi: False Love, Ranma ½ (2024))
- [x] Phase A3: Determine and propose the smallest correct fix — approved by user, implemented
- [x] Phase A4: Identity confirmation improvements — `source: 'app-confirmation'` bypasses title/year sanity only; all other safety floors untouched
- [x] Phase A5: Proposal UX — structured reason codes (`reasonCode`/`availableActions` on `MigrationProposalDto`, mobile renders short summary + collapsible detail)
- [x] Phase A6: Regression audit — no duplicate seriesIds, Black Clover/Bleach/Naruto Shippuden still correctly unresolved, remakes/sequels unaffected (fix never touches candidate search/matching)
- [x] Phase A7: Tests + typecheck — server 96/1255 passing (3 stable full-suite runs), mobile 8/50 passing + lint clean, tsc clean both repos

## Workstream B — "Haven't Started Yet" Home carousel

- [x] Define eligibility query (WATCHLIST, 0 watches, ≥1 released regular episode, confirmed provider mapping, Home-eligible) — `deriveHavenStartedYetCandidates` in `me-query-helpers.ts`
- [x] Sort: newest released first, then alphabetical — `sortHavenStartedYetResults`
- [x] Reuse existing carousel/card infra (no duplication) — same rail `FlatList` + `SeriesCard variant="rail"` pattern as Recently Watched / Haven't Watched For A While
- [x] Validation per the 7 listed checks — 15 unit tests + live fixture proof (created, verified, watched → disappeared, cleaned up) against real dev DB

## Findings log

### Phase A1 — flow trace
- List (`GET /migration-workbench`) is not the site of the bug — cache-invalidation already fixed earlier in this session.
- `GET /migration-workbench/:seriesId/proposal` is the live decision point: `eligible: boolean` gates everything downstream.
- `MigrationProposalDto` → mobile `MigrationProposalScreen.tsx`: `Confirm Migration` button renders `{data.eligible ? <Button/> : null}` — **faithfully reflects backend `eligible`, no mobile bug** (ruled out C/D — not a hidden button, not a layout bug). Mobile also renders the raw `reason` string as plain body text — real Phase A5 concern (huge diagnostic dumps as primary UI), but not a *correctness* bug.
- Backend refusal happens inside `runProviderConfirmationForDecision` at one of two independent hard floors: `checkTitleYearSanity` (identity) or `detectRealSeasonShrink` (catalog shape).

### Phase A2 — audited examples
All 3 already have a **confirmed `ProviderIdentityDecision`** (`source: 'app-confirmation'`, very recent) but zero `MigrationHistory` — user explicitly confirmed identity through the app already; something downstream still refuses.

| Series | Local title | Provider title | Similarity | Sanity check | Block reason | Classification |
|---|---|---|---|---|---|---|
| Mirai Nikki | "Mirai Nikki" | "The Future Diary" (tmdb:46671) | 0.13 (floor 0.6) | **fails** | title/year sanity | **F — multiple issues**: translated-title mismatch AND local catalog has 0 episodes (empty stub) |
| Nisekoi: False Love | "Nisekoi: False Love" | "Nisekoi" (tmdb:62640) | 0.37 (floor 0.6) | **fails** | title/year sanity | **B — incorrectly blocked**: real 20-episode local catalog, all watched; alternate/shortened title only |
| Ranma ½ (2024) | "Ranma ½ (2024)" | "Ranma1/2" (tmdb:259140) | passes (fuzzy+year exact) | **passes** | `detectRealSeasonShrink`: local season 2 (12 eps) has no provider counterpart | **B — incorrectly blocked**, different mechanism: total episode count matches exactly (24=24); candidate search itself already classified this as `NEEDS_ABSOLUTE_NUMBERING_PROVIDER` (a known, named pattern) at search time, but that signal never reaches the later apply-time check, which only sees a naive per-season-number count mismatch |

**Root cause, precisely: NOT title similarity in general** — confirmed title similarity is A real factor for 2/3 (translated/alternate titles), but the deeper root cause is structural: `runProviderConfirmationForDecision` re-derives identity and catalog-shape checks from scratch on every call, with no way to know a human already explicitly confirmed this exact provider/providerId via the app's Find Provider flow, and no way to reuse the more specific classification the candidate-search stage already computed.

### Phase A3 — proposed fix (pending confirmation)
1. **Identity-trust gap** (fixes Mirai Nikki + Nisekoi): thread `ProviderIdentityDecision.source` through to `runProviderConfirmationForDecision`; when `source === 'app-confirmation'`, treat `checkTitleYearSanity` as passed (the human already visually compared and explicitly selected this exact candidate) while still recording the real computed similarity in the reason for auditability. Scoped narrowly to identity only — `detectRealSeasonShrink`, orphan checks, and catalog validation are completely untouched, matching "explicit confirmation must never bypass season shrink protection, catalog mismatch detection, orphan protection, watched mapping validation."
2. **Ranma ½ (2024) / absolute-numbering**: the existing `seasonShrinkReviewed` mechanism (built earlier this session) is the correct, already-safe escape hatch for this pattern — but there is currently no API/mobile surface for a normal user to set it (I set it via a direct script for the earlier completed-series batch). Proposing to add a proper endpoint + mobile action so a user can explicitly review and approve a season-structure mismatch, mirroring the identity-confirmation trust model. **Open question for user**: is adding this new API surface in scope for this task, or should Ranma ½ (2024)'s case be reported as correctly-blocked-pending-a-future-feature?
3. Mirai Nikki's empty local catalog is not a bug to fix — once identity-trust is fixed, it will simply produce a (correct, if unglamorous) proposal with 0 matched episodes.
