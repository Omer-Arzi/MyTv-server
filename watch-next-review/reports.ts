import { mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import { WatchNextReviewRow } from './build-review';

export interface ReviewReportMeta {
  generatedAt: Date;
  userId: string;
  tvmazeAuditSourcePath: string | null;
}

// The four decisions a human can make for each row — this pipeline never
// picks one itself; "needs_mapping" and the rest are just checklist labels
// in the markdown, filled in by whoever reviews the report.
export type ManualDecision = 'keep_in_watch_next' | 'mark_caught_up' | 'needs_mapping' | 'ignore_for_now';
const MANUAL_DECISION_OPTIONS: ManualDecision[] = ['keep_in_watch_next', 'mark_caught_up', 'needs_mapping', 'ignore_for_now'];

export function buildJsonReport(meta: ReviewReportMeta, rows: WatchNextReviewRow[]) {
  const counts: Record<string, number> = {};
  for (const r of rows) counts[r.category] = (counts[r.category] ?? 0) + 1;

  return {
    generatedAt: meta.generatedAt.toISOString(),
    userId: meta.userId,
    tvmazeAuditSourcePath: meta.tvmazeAuditSourcePath,
    writesToAppTables: false,
    decisionApplied: false,
    summary: {
      totalWatchNextItems: rows.length,
      byCategory: counts,
    },
    items: rows,
  };
}

function fmtDate(iso: string | null): string {
  if (!iso) return 'unknown';
  return iso.slice(0, 10);
}

function buildMarkdownReport(meta: ReviewReportMeta, rows: WatchNextReviewRow[]): string {
  const lines: string[] = [];
  lines.push('# Watch Next — Manual Review');
  lines.push('');
  lines.push(`Generated: ${meta.generatedAt.toISOString()}`);
  lines.push(`TVmaze audit source: ${meta.tvmazeAuditSourcePath ?? 'none'}`);
  lines.push('');
  lines.push('This report makes no changes. Every "Decision" checklist below is for a human to fill in manually.');
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  const counts: Record<string, number> = {};
  for (const r of rows) counts[r.category] = (counts[r.category] ?? 0) + 1;
  for (const [category, count] of Object.entries(counts)) {
    lines.push(`- **${category}**: ${count}`);
  }
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const r of rows) {
    lines.push(`## ${r.seriesTitle}`);
    lines.push('');
    lines.push(`**Category**: \`${r.category}\` — ${r.categoryReason}`);
    lines.push('');
    lines.push('### MyTv / TMDb opinion');
    lines.push('');
    lines.push(`- MyTv series id: \`${r.mytvSeriesId}\``);
    lines.push(`- userStatus: ${r.userStatus} · releaseStatus: ${r.releaseStatus}`);
    lines.push(`- TMDb id: ${r.tmdbId ?? '_none_'}`);
    lines.push(`- Current next episode: **S${r.currentNextEpisode.seasonNumber}E${r.currentNextEpisode.episodeNumber}**${r.currentNextEpisode.title ? ` — "${r.currentNextEpisode.title}"` : ''} (episode id \`${r.currentNextEpisode.episodeId}\`, airDate ${fmtDate(r.currentNextEpisode.airDate)})`);
    lines.push(
      r.lastWatchedEpisode
        ? `- Last watched: S${r.lastWatchedEpisode.seasonNumber}E${r.lastWatchedEpisode.episodeNumber}${r.lastWatchedEpisode.title ? ` — "${r.lastWatchedEpisode.title}"` : ''} on ${fmtDate(r.lastWatchedEpisode.watchedAt)}`
        : '- Last watched: _none recorded_',
    );
    lines.push(`- Watched ${r.watchedEpisodeCount} of ${r.mytvKnownEpisodeCount} known episodes`);
    lines.push('');
    lines.push('### TVmaze opinion');
    lines.push('');
    if (r.tvmazeCandidate) {
      lines.push(`- Candidate: "${r.tvmazeCandidate.tvmazeTitle}" (${r.tvmazeCandidate.tvmazeYear ?? 'unknown year'}, tvmazeId ${r.tvmazeCandidate.tvmazeId})`);
      lines.push(`- TVmaze known episode count: ${r.tvmazeKnownEpisodeCount ?? 'unknown'}`);
      lines.push(`- Thinks caught up by chronological position: ${r.tvmazeThinksCaughtUpByPosition ? 'YES' : 'no'}`);
      lines.push(`- Proposed next episode is a TBA placeholder: ${r.tvmazeNextEpisodeIsTBA ? 'YES' : 'no'}`);
    } else {
      lines.push('- No TVmaze candidate found for this series.');
    }
    lines.push('');
    lines.push('### Recommended action');
    lines.push('');
    lines.push(recommendedActionFor(r.category));
    lines.push('');
    lines.push('### Decision (fill in manually — check exactly one)');
    lines.push('');
    for (const option of MANUAL_DECISION_OPTIONS) {
      lines.push(`- [ ] ${option}`);
    }
    lines.push('');
    lines.push('---');
    lines.push('');
  }

  return lines.join('\n');
}

function recommendedActionFor(category: WatchNextReviewRow['category']): string {
  switch (category) {
    case 'KEEP_IN_WATCH_NEXT_CONFIDENT':
      return 'Both providers agree — safe to leave as-is in Watch Next.';
    case 'PROVIDER_EPISODE_COUNT_DISAGREEMENT':
      return 'Providers disagree on catalog size — worth a quick manual check of which is right before trusting either.';
    case 'TVMAZE_SAYS_CAUGHT_UP':
      return 'TVmaze thinks nothing is left to watch; MyTv/TMDb disagrees — confirm whether the extra episodes MyTv knows about actually exist before deciding.';
    case 'TVMAZE_NEXT_IS_TBA':
      return "TVmaze's own catalog has no real next episode either — no independent confirmation available; treat current data as the only source for now.";
    case 'NO_SECONDARY_PROVIDER_MATCH':
      return 'TVmaze has nothing for this title — no independent check possible; rely on TMDb/manual knowledge.';
    case 'REMAKE_COLLISION':
      return 'A title collision was detected — confirm the TMDb match itself is the right show before trusting its episode data at all.';
    case 'NEEDS_MANUAL_DECISION':
    default:
      return 'No single signal resolved this cleanly — needs a manual look at the full data above.';
  }
}

export function writeWatchNextReview(outDir: string, meta: ReviewReportMeta, rows: WatchNextReviewRow[]) {
  mkdirSync(outDir, { recursive: true });

  const jsonPath = path.join(outDir, 'watch-next-manual-review.json');
  const mdPath = path.join(outDir, 'watch-next-manual-review.md');

  writeFileSync(jsonPath, JSON.stringify(buildJsonReport(meta, rows), null, 2));
  writeFileSync(mdPath, buildMarkdownReport(meta, rows));

  return { jsonPath, mdPath };
}
