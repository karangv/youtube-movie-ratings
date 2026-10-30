import {
  API_KEY_STORAGE_KEY,
  CACHE_PREFIX,
  type CacheEntry,
  type GetRatingsMessage,
  type Ratings,
  type RatingsResponse,
} from '@/utils/ratings';
import { DEV_STATS_KEY, emptyDevStats, type DevStats, type RecordBatchMessage } from '@/utils/devStats';

const FOUND_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const NOT_FOUND_TTL_MS = 24 * 60 * 60 * 1000; // 1 day so misses get retried sooner

// Movies currently being fetched. If two cards ask for the same movie at the
// same time they share one OMDb request instead of making two.
const inFlight = new Map<string, Promise<RatingsResponse>>();

export default defineBackground(() => {
  console.log('Youtube Movie Ratings background script loaded', { id: browser.runtime.id });

  // Chrome doesn't support returning a promise here, so return true to keep
  // the channel open and call sendResponse once we have the answer.
  browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'RECORD_BATCH') {
      recordBatch(message as RecordBatchMessage);
      return false;
    }
    if (message?.type !== 'GET_RATINGS') return false;

    handleGetRatings(message as GetRatingsMessage)
      .then(sendResponse)
      .catch((error) => sendResponse({ status: 'error', message: String(error) }));
    return true;
  });
});

/**
 * Handles a GET_RATINGS message. Checks the cache first and only calls OMDb
 * if there's no fresh entry for the movie.
 * @param message
 * @returns the ratings response to send back to the content script.
 */
async function handleGetRatings(message: GetRatingsMessage): Promise<RatingsResponse> {
  const start = performance.now();
  const result = await browser.storage.local.get(API_KEY_STORAGE_KEY);
  const omdbApiKey = result[API_KEY_STORAGE_KEY] as string | undefined;
  if (!omdbApiKey) {
    return { status: 'no_api_key' };
  }

  const { title, year } = message.payload;
  const cleanedTitle = cleanTitle(title);
  const cacheKey = `${CACHE_PREFIX}${cleanedTitle.toLowerCase()}_${year ?? ''}`;

  const cachedResult = await browser.storage.local.get(cacheKey);
  const cached = cachedResult[cacheKey] as CacheEntry | undefined;
  if (cached) {
    const ttl = cached.ratings ? FOUND_TTL_MS : NOT_FOUND_TTL_MS;
    if (Date.now() - cached.cachedAt < ttl) {
      const elapsed = performance.now() - start;
      recordStats((stats) => {
        stats.lookups++;
        stats.cacheHits++;
        stats.cachedLookupMsTotal += elapsed;
      });
      return cached.ratings ? { status: 'ok', ratings: cached.ratings } : { status: 'not_found' };
    }
  }

  const existing = inFlight.get(cacheKey);
  if (existing) {
    recordStats((stats) => {
      stats.lookups++;
      stats.sharedRequests++;
    });
    return existing;
  }

  const request = fetchAndCache(cacheKey, cleanedTitle, year, omdbApiKey).finally(() => inFlight.delete(cacheKey));
  inFlight.set(cacheKey, request);
  const response = await request;
  const elapsed = performance.now() - start;
  recordStats((stats) => {
    stats.lookups++;
    stats.fetchLookups++;
    stats.fetchLookupMsTotal += elapsed;
  });
  return response;
}

/**
 * Fetches ratings from OMDb and saves the result to the cache. Errors aren't cached so they get retried.
 * @param cacheKey
 * @param title
 * @param year
 * @param omdbApiKey
 * @returns the ratings response from fetchMovieRatings.
 */
async function fetchAndCache(cacheKey: string, title: string, year: string | undefined, omdbApiKey: string): Promise<RatingsResponse> {
  const response = await fetchMovieRatings(title, year, omdbApiKey);
  // Don't cache errors (bad key, rate limit, network) so they get retried
  if (response.status === 'ok' || response.status === 'not_found') {
    const entry: CacheEntry = {
      ratings: response.status === 'ok' ? response.ratings : null,
      cachedAt: Date.now(),
    };
    await browser.storage.local.set({ [cacheKey]: entry });
  }
  return response;
}

/**
 * Cleans the movie title by removing common patterns
 * that might interfere with accurate searches in the OMDB API.
 * @param title
 * @returns A cleaned version of the movie title, with extraneous information removed.
 */
function cleanTitle(title: string): string {
  const patterns = [
    /\s*\(\d{4}\)\s*$/, // Remove year in parentheses
    /^(Marvel Studios|Disney|Pixar|DreamWorks|Disney\s*\/\s*Pixar)['’]s?\s+/i, // Remove studio prefixes like "Marvel Studios' "
    /\s*[([](Extended Edition|Extended Cut|Director['’]s Cut|Unrated|Theatrical Cut|Theatrical Version|Remastered|\d+th Anniversary Edition|4K|HD)[)\]]\s*$/i,
    /\s*[-–|]\s*(Official )?(Full Movie|Trailer)\s*$/i,
  ];
  let cleanedTitle = title;
  for (const pattern of patterns) {
    cleanedTitle = cleanedTitle.replace(pattern, '');
  }
  return cleanedTitle.trim();
}


/**
 * Fetches movie ratings from the OMDB API. If the title + year doesn't match anything it tries
 * the part before the colon, then the title without the year (YouTube's year is sometimes off by one).
 * @param title
 * @param year
 * @param omdbApiKey
 * @returns the ratings, not_found if OMDb has no match, or error if the request failed.
 */
async function fetchMovieRatings(title: string, year: string | undefined, omdbApiKey: string): Promise<RatingsResponse> {
  const attempts: { title: string; year?: string }[] = [{ title, year }];
  if (title.includes(':')) {
    attempts.push({ title: title.split(':')[0].trim(), year });
  }
  if (year) {
    attempts.push({ title });
  }

  try {
    for (const [index, attempt] of attempts.entries()) {
      const omdbData = await queryOmdb(attempt.title, attempt.year, omdbApiKey);
      if (omdbData.Response === 'True') {
        const ratings = getRatings(omdbData);
        recordStats((stats) => {
          stats.found++;
          if (index > 0) stats.foundViaFallback++;
          if (Object.values(ratings).every((value) => value !== 'N/A')) stats.foundWithAllRatings++;
        });
        return { status: 'ok', ratings };
      }
      // Retrying won't help with a bad key or hitting the rate limit
      if (omdbData.Error !== 'Movie not found!') {
        console.warn(`OMDB API error for ${title} (${year}):`, omdbData.Error);
        recordStats((stats) => stats.errors++);
        return { status: 'error', message: omdbData.Error ?? 'Unknown OMDb error' };
      }
    }
    recordStats((stats) => stats.notFound++);
    return { status: 'not_found' };
  } catch (error) {
    console.error('Error fetching movie ratings:', error);
    recordStats((stats) => stats.errors++);
    return { status: 'error', message: 'Could not reach OMDb' };
  }
}

/**
 * Makes a single request to the OMDB API and records how long it took.
 * @param title
 * @param year
 * @param omdbApiKey
 * @returns the raw JSON response from OMDb.
 */
async function queryOmdb(title: string, year: string | undefined, omdbApiKey: string): Promise<any> {
  const params = new URLSearchParams({ t: title, type: 'movie', apikey: omdbApiKey });
  if (year) params.set('y', year);
  const start = performance.now();
  const omdbResponse = await fetch(`https://www.omdbapi.com/?${params}`);
  const omdbData = await omdbResponse.json();
  const elapsed = performance.now() - start;
  recordStats((stats) => {
    stats.omdbRequests++;
    stats.omdbRequestMsTotal += elapsed;
  });
  return omdbData;
}

/**
 * Extracts ratings from OMDB data, providing defaults if not available.
 * @param omdbData
 * @returns An object containing imdbRating, rtRating, and metacriticRating, with 'N/A' as default if not found.
 */
function getRatings(omdbData: any): Ratings {
  const rtRating = omdbData.Ratings?.find((r: any) => r.Source === 'Rotten Tomatoes')?.Value || 'N/A';
  const metacriticRating = omdbData.Ratings?.find((r: any) => r.Source === 'Metacritic')?.Value || 'N/A';
  const imdbRating = omdbData.imdbRating || 'N/A';
  return { imdbRating, rtRating, metacriticRating };
}

// Dev stats

// Each update reads the stats, changes them and saves them back, so updates have to run
// one at a time. Otherwise two updates landing together would overwrite each other.
let statsQueue: Promise<void> = Promise.resolve();

/**
 * Queues an update to the dev stats. Updates run one at a time so they don't overwrite each other.
 * @param update
 */
function recordStats(update: (stats: DevStats) => void): void {
  statsQueue = statsQueue
    .then(async () => {
      const result = await browser.storage.local.get(DEV_STATS_KEY);
      const stats = (result[DEV_STATS_KEY] as DevStats | undefined) ?? emptyDevStats();
      update(stats);
      await browser.storage.local.set({ [DEV_STATS_KEY]: stats });
    })
    .catch((error) => console.error('Failed to record dev stats:', error));
}

/**
 * Adds a batch timing sent from the content script to the dev stats.
 * @param message
 */
function recordBatch(message: RecordBatchMessage): void {
  const { cards, ms } = message.payload;
  recordStats((stats) => {
    stats.batches++;
    stats.batchCardsTotal += cards;
    stats.batchMsTotal += ms;
    if (ms > stats.slowestBatchMs) {
      stats.slowestBatchMs = ms;
      stats.slowestBatchCards = cards;
    }
  });
}
