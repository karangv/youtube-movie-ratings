// Counters for the "Developer stats" section in the popup.
// Only the background script writes these, the popup just reads and resets them.
import type { PillSource } from './recommendations';

export const DEV_STATS_KEY = 'devStats';

export interface DevStats {
  since: number;

  // lookups = cacheHits + sharedRequests + fetchLookups
  lookups: number;
  cacheHits: number;
  sharedRequests: number; // reused a request for the same movie that was already running
  fetchLookups: number; // actually had to call OMDb

  cachedLookupMsTotal: number;
  fetchLookupMsTotal: number;

  // Raw OMDb requests (one lookup can make up to 3)
  omdbRequests: number;
  omdbRequestMsTotal: number;

  // Results of the fetch lookups
  found: number;
  foundViaFallback: number; // only found after shortening the title or dropping the year
  foundWithAllRatings: number; // has IMDb, RT and Metacritic
  notFound: number;
  errors: number;

  // A batch is a group of cards rated together, like when a page first loads
  batches: number;
  batchCardsTotal: number;
  batchMsTotal: number;
  slowestBatchMs: number;
  slowestBatchCards: number;

  // Recommendations. Votes on cards with a "For you" pill are split by what put it there (an algorithm
  // or the random control), so the 👍 rate can be compared between them and against cards without a pill.
  forYou: Record<PillSource, ForYouStats>;
  otherVotesUp: number;
  otherVotesDown: number;
}

export interface ForYouStats {
  shown: number; // different movies that got a "For you" pill
  votesUp: number;
  votesDown: number;
}

export interface RecordBatchMessage {
  type: 'RECORD_BATCH';
  payload: { cards: number; ms: number };
}

export interface RecordForYouMessage {
  type: 'RECORD_FOR_YOU';
  payload: { source: PillSource };
}

/**
 * Creates a fresh set of stats with every counter at 0.
 * @returns the empty stats, with since set to now.
 */
export function emptyDevStats(): DevStats {
  return {
    since: Date.now(),
    lookups: 0,
    cacheHits: 0,
    sharedRequests: 0,
    fetchLookups: 0,
    cachedLookupMsTotal: 0,
    fetchLookupMsTotal: 0,
    omdbRequests: 0,
    omdbRequestMsTotal: 0,
    found: 0,
    foundViaFallback: 0,
    foundWithAllRatings: 0,
    notFound: 0,
    errors: 0,
    batches: 0,
    batchCardsTotal: 0,
    batchMsTotal: 0,
    slowestBatchMs: 0,
    slowestBatchCards: 0,
    forYou: {
      cosine: { shown: 0, votesUp: 0, votesDown: 0 },
      naiveBayes: { shown: 0, votesUp: 0, votesDown: 0 },
      random: { shown: 0, votesUp: 0, votesDown: 0 },
    },
    otherVotesUp: 0,
    otherVotesDown: 0,
  };
}

/**
 * Fills in any fields missing from saved stats, like ones added in a newer version.
 * The forYou groups are filled in too, since a plain spread would only fill in the top level.
 * @param stored
 * @returns complete stats.
 */
export function normalizeDevStats(stored: Partial<DevStats> | undefined): DevStats {
  const empty = emptyDevStats();
  return { ...empty, ...stored, forYou: { ...empty.forYou, ...stored?.forYou } };
}
