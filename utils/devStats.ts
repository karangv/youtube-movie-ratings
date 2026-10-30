// Counters for the "Developer stats" section in the popup.
// Only the background script writes these, the popup just reads and resets them.

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
}

export interface RecordBatchMessage {
  type: 'RECORD_BATCH';
  payload: { cards: number; ms: number };
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
  };
}
