import { decideTier, detectAnimeNumberingRisk, detectCloseCompetitor, evaluateStructuralAutoMatch, parseYearFromDate, scoreCandidates } from '../scoring';
import { TmdbTvSearchResult } from '../tmdb-types';

function result(name: string, firstAirDate: string | null, id = 1): TmdbTvSearchResult {
  return { id, name, first_air_date: firstAirDate };
}

describe('parseYearFromDate', () => {
  it('extracts the year from a full YYYY-MM-DD date', () => {
    expect(parseYearFromDate('2005-03-26')).toBe(2005);
  });

  it('returns null for a missing date', () => {
    expect(parseYearFromDate(null)).toBeNull();
    expect(parseYearFromDate(undefined)).toBeNull();
    expect(parseYearFromDate('')).toBeNull();
  });
});

describe('scoreCandidates', () => {
  it('gives an exact title + exact year match the maximum score for the top-ranked result', () => {
    const [best] = scoreCandidates({ bareTitle: 'Doctor Who', titleYear: 2005 }, [result('Doctor Who', '2005-03-26')]);

    expect(best.breakdown.titleMatchType).toBe('exact');
    expect(best.breakdown.titleScore).toBe(50);
    expect(best.breakdown.yearMatchType).toBe('exact');
    expect(best.breakdown.yearScore).toBe(30);
    expect(best.breakdown.rankRelevanceScore).toBe(20);
    expect(best.breakdown.totalScore).toBe(100);
  });

  it('does not penalize a missing year hint', () => {
    const [best] = scoreCandidates({ bareTitle: 'Futurama', titleYear: null }, [result('Futurama', '1999-03-28')]);

    expect(best.breakdown.yearMatchType).toBe('unknown');
    expect(best.breakdown.yearScore).toBe(10);
  });

  it('penalizes a year that is known and clearly wrong', () => {
    const [best] = scoreCandidates({ bareTitle: 'Doctor Who', titleYear: 2005 }, [result('Doctor Who', '2023-11-25')]);

    expect(best.breakdown.yearMatchType).toBe('mismatch');
    expect(best.breakdown.yearScore).toBe(0);
  });

  it('scores relevance by TMDb result position, decaying by 2 points per rank', () => {
    const scored = scoreCandidates({ bareTitle: 'X', titleYear: null }, [result('X', null, 1), result('X', null, 2), result('X', null, 3)]);

    // scored is re-sorted by totalScore, but all three tie on title/year, so
    // original TMDb order (id 1,2,3) determines rankRelevanceScore before the sort
    const byId = Object.fromEntries(scored.map((c) => [c.result.id, c.breakdown.rankRelevanceScore]));
    expect(byId[1]).toBe(20);
    expect(byId[2]).toBe(18);
    expect(byId[3]).toBe(16);
  });

  it('ranks candidates by total score, highest first, even against TMDbs own ordering', () => {
    const scored = scoreCandidates({ bareTitle: 'Doctor Who', titleYear: 2005 }, [
      result('Doctor Who', '2023-11-25', 1), // TMDb ranked this first
      result('Doctor Who', '2005-03-26', 2), // but this is the actual year match
    ]);

    expect(scored[0].result.id).toBe(2);
  });
});

describe('decideTier', () => {
  it('is NO_MATCH when there are no candidates', () => {
    expect(decideTier([]).tier).toBe('NO_MATCH');
  });

  it('is AUTO_MATCH for a high score with a clear gap to the runner-up', () => {
    const scored = scoreCandidates({ bareTitle: 'Doctor Who', titleYear: 2005 }, [
      result('Doctor Who', '2005-03-26', 1),
      result('Something Else', '1990-01-01', 2),
    ]);

    expect(decideTier(scored).tier).toBe('AUTO_MATCH');
  });

  it('is NEEDS_REVIEW when a close second makes a high score ambiguous', () => {
    const scored = scoreCandidates({ bareTitle: 'Doctor Who', titleYear: null }, [
      result('Doctor Who', '2005-03-26', 1),
      result('Doctor Who', '2023-11-25', 2),
    ]);

    expect(decideTier(scored).tier).toBe('NEEDS_REVIEW');
  });

  it('is NO_MATCH for a very poor top score', () => {
    const scored = scoreCandidates({ bareTitle: 'One Piece', titleYear: 2023 }, [result('Completely Different Show', '1980-01-01', 1)]);

    expect(decideTier(scored).tier).toBe('NO_MATCH');
  });
});

describe('detectAnimeNumberingRisk', () => {
  it('is false for a short-running show regardless of origin', () => {
    expect(
      detectAnimeNumberingRisk({ watchedEpisodeCount: 12, tmdbTotalEpisodeCount: 12, originalLanguage: 'ja', originCountry: ['JP'] }),
    ).toBe(false);
  });

  it('is false for a long-running show that is not anime', () => {
    expect(
      detectAnimeNumberingRisk({ watchedEpisodeCount: 280, tmdbTotalEpisodeCount: 280, originalLanguage: 'en', originCountry: ['US'], genres: [{ id: 35, name: 'Comedy' }] }),
    ).toBe(false);
  });

  it('is true for a long-running Japanese-origin-language show', () => {
    expect(detectAnimeNumberingRisk({ watchedEpisodeCount: 1157, tmdbTotalEpisodeCount: 1157, originalLanguage: 'ja', originCountry: ['JP'] })).toBe(true);
  });

  it('is true for a long-running show with an Animation genre even without JP metadata', () => {
    expect(
      detectAnimeNumberingRisk({ watchedEpisodeCount: 150, tmdbTotalEpisodeCount: 150, genres: [{ id: 16, name: 'Animation' }], originalLanguage: 'en' }),
    ).toBe(true);
  });

  it('uses the larger of watched vs TMDb-reported total to decide long-running', () => {
    // TMDb might report fewer episodes than we've actually watched (a
    // mismatch that's itself informative) — still counts as long-running.
    expect(detectAnimeNumberingRisk({ watchedEpisodeCount: 150, tmdbTotalEpisodeCount: 10, originalLanguage: 'ja' })).toBe(true);
  });
});

describe('detectCloseCompetitor', () => {
  const top = { tmdbId: '1', tmdbTitle: 'Avatar: The Last Airbender', tmdbYear: 2024, confidenceScore: 80 };

  it('is not detected when there are no other candidates', () => {
    expect(detectCloseCompetitor(top, [])).toEqual({ detected: false, reason: null, kind: null });
  });

  it('is not detected when other candidates are clearly different and far apart in score', () => {
    const others = [{ tmdbId: '2', tmdbTitle: 'Completely Unrelated Show', tmdbYear: 1998, confidenceScore: 30 }];
    expect(detectCloseCompetitor(top, others).detected).toBe(false);
  });

  it('detects a same-titled candidate with a different year as a remake/reboot ambiguity', () => {
    const others = [{ tmdbId: '2', tmdbTitle: 'Avatar: The Last Airbender', tmdbYear: 2005, confidenceScore: 78 }];
    const result = detectCloseCompetitor(top, others);

    expect(result.detected).toBe(true);
    expect(result.kind).toBe('same_title_different_year');
    expect(result.reason).toContain('different year');
  });

  it('detects a near-exact (but not identical) title as a close competitor', () => {
    const others = [{ tmdbId: '2', tmdbTitle: 'Avatar The Last Airbender', tmdbYear: 2024, confidenceScore: 40 }];
    const result = detectCloseCompetitor(top, others);

    expect(result.detected).toBe(true);
    expect(result.kind).toBe('near_exact_title');
  });

  it('detects an unrelated-titled candidate within 10 confidence points as a close competitor', () => {
    const others = [{ tmdbId: '2', tmdbTitle: 'A Totally Different Show', tmdbYear: 2010, confidenceScore: 72 }];
    const result = detectCloseCompetitor(top, others);

    expect(result.detected).toBe(true);
    expect(result.kind).toBe('score_gap');
  });

  it('is not detected when the score gap exceeds 10 points and titles are unrelated', () => {
    const others = [{ tmdbId: '2', tmdbTitle: 'A Totally Different Show', tmdbYear: 2010, confidenceScore: 69 }];
    expect(detectCloseCompetitor(top, others).detected).toBe(false);
  });
});

describe('evaluateStructuralAutoMatch', () => {
  const baseInput = {
    tier: 'NEEDS_REVIEW' as const,
    titleMatchType: 'exact' as const,
    resultPosition: 0,
    watchedEpisodeCount: 25,
    tmdbTotalEpisodeCount: 25,
    animeNumberingRiskDetected: false,
    closeCompetitorDetected: false,
  };

  it('proposes AUTO_MATCH when every condition passes', () => {
    const result = evaluateStructuralAutoMatch(baseInput);
    expect(result.proposedTier).toBe('AUTO_MATCH');
  });

  it('keeps NEEDS_REVIEW when the current tier is not NEEDS_REVIEW', () => {
    expect(evaluateStructuralAutoMatch({ ...baseInput, tier: 'AUTO_MATCH' }).proposedTier).toBe('NEEDS_REVIEW');
    expect(evaluateStructuralAutoMatch({ ...baseInput, tier: 'NO_MATCH' }).proposedTier).toBe('NEEDS_REVIEW');
  });

  it('keeps NEEDS_REVIEW when the title match is not exact', () => {
    expect(evaluateStructuralAutoMatch({ ...baseInput, titleMatchType: 'fuzzy' }).proposedTier).toBe('NEEDS_REVIEW');
  });

  it('keeps NEEDS_REVIEW when the top candidate is not the top search result', () => {
    expect(evaluateStructuralAutoMatch({ ...baseInput, resultPosition: 1 }).proposedTier).toBe('NEEDS_REVIEW');
  });

  it('blocks structural auto-match when watched episode count exceeds the TMDb total (watched > total)', () => {
    const result = evaluateStructuralAutoMatch({ ...baseInput, watchedEpisodeCount: 61, tmdbTotalEpisodeCount: 15 });
    expect(result.proposedTier).toBe('NEEDS_REVIEW');
    expect(result.reason).toContain('exceeds');
  });

  it('keeps watched < total in NEEDS_REVIEW for now, even though nothing else is wrong', () => {
    const result = evaluateStructuralAutoMatch({ ...baseInput, watchedEpisodeCount: 5, tmdbTotalEpisodeCount: 12 });
    expect(result.proposedTier).toBe('NEEDS_REVIEW');
    expect(result.reason).toContain('still in progress');
  });

  it('blocks structural auto-match when anime/long-running numbering risk is detected, even if everything else passes', () => {
    const result = evaluateStructuralAutoMatch({ ...baseInput, watchedEpisodeCount: 293, tmdbTotalEpisodeCount: 293, animeNumberingRiskDetected: true });
    expect(result.proposedTier).toBe('NEEDS_REVIEW');
    expect(result.reason).toContain('anime');
  });

  it('blocks structural auto-match when a close competitor was detected', () => {
    const result = evaluateStructuralAutoMatch({ ...baseInput, closeCompetitorDetected: true });
    expect(result.proposedTier).toBe('NEEDS_REVIEW');
    expect(result.reason).toContain('close competing candidate');
  });
});
