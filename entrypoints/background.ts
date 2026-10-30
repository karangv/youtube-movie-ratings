import {
  API_KEY_STORAGE_KEY,
  CACHE_KEY_PREFIX,
  CACHE_PREFIX,
  type CacheEntry,
  type GetRatingsMessage,
  type MovieInfo,
  type Ratings,
  type RatingsResponse,
} from '@/utils/ratings';
import {
  DEV_STATS_KEY,
  normalizeDevStats,
  type DevStats,
  type RecordBatchMessage,
  type RecordForYouMessage,
} from '@/utils/devStats';
import {
  RECOMMENDATIONS_KEY,
  emptyRecommendationStore,
  type RateMovieMessage,
  type RecommendationStore,
} from '@/utils/recommendations';

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
    if (message?.type === 'RECORD_FOR_YOU') {
      const { source } = (message as RecordForYouMessage).payload;
      recordStats((stats) => stats.forYou[source].shown++);
      return false;
    }
    if (message?.type === 'RATE_MOVIE') {
      handleRateMovie(message as RateMovieMessage);
      return false;
    }
    if (message?.type !== 'GET_RATINGS') return false;

    handleGetRatings(message as GetRatingsMessage)
      .then(sendResponse)
      .catch((error) => sendResponse({ status: 'error', message: String(error) }));
    return true;
  });

  // Runs when the extension is installed or updated
  browser.runtime.onInstalled.addListener(() => {
    removeOldCacheEntries();
  });
});

/**
 * Deletes cache entries from older versions of the cache format so they don't sit in storage forever.
 */
async function removeOldCacheEntries(): Promise<void> {
  const all = await browser.storage.local.get(null);
  const oldKeys = Object.keys(all).filter((key) => key.startsWith(CACHE_PREFIX) && !key.startsWith(CACHE_KEY_PREFIX));
  if (oldKeys.length > 0) {
    await browser.storage.local.remove(oldKeys);
    console.log(`Removed ${oldKeys.length} old cache entries`);
  }
}

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
  const cacheKey = `${CACHE_KEY_PREFIX}${cleanedTitle.toLowerCase()}_${year ?? ''}`;

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
      return cached.ratings && cached.info
        ? { status: 'ok', ratings: cached.ratings, info: cached.info }
        : { status: 'not_found' };
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
      info: response.status === 'ok' ? response.info : null,
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
        return { status: 'ok', ratings, info: getMovieInfo(omdbData) };
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

/**
 * Pulls the details used for recommendations out of OMDB data.
 * OMDb gives lists as comma separated strings like "Action, Crime, Drama", or 'N/A' when missing.
 * @param omdbData
 * @returns the movie's IMDb id, genres, directors, actors and year.
 */
function getMovieInfo(omdbData: any): MovieInfo {
  const toList = (value: string | undefined) =>
    !value || value === 'N/A' ? [] : value.split(',').map((item) => item.trim()).filter(Boolean);
  const year = parseInt(omdbData.Year, 10);
  return {
    imdbId: omdbData.imdbID,
    genres: toList(omdbData.Genre),
    directors: toList(omdbData.Director),
    actors: toList(omdbData.Actors),
    year: isNaN(year) ? undefined : year,
  };
}

// Recommendations

/**
 * Saves (or removes, when vote is 0) the user's thumbs up/down for a movie.
 * @param message
 */
function handleRateMovie(message: RateMovieMessage): void {
  const { title, info, ratings, vote, forYouSource } = message.payload;
  const normalizeStore = (stored: Partial<RecommendationStore> | undefined) => ({ ...emptyRecommendationStore(), ...stored });
  queueUpdate(RECOMMENDATIONS_KEY, normalizeStore, (store) => {
    if (vote === 0) {
      delete store.votes[info.imdbId];
    } else {
      store.votes[info.imdbId] = { vote, title, info, ratings, votedAt: Date.now() };
    }
  });

  if (vote === 0) return;
  recordStats((stats) => {
    if (forYouSource) {
      const forYou = stats.forYou[forYouSource];
      vote === 1 ? forYou.votesUp++ : forYou.votesDown++;
    } else {
      vote === 1 ? stats.otherVotesUp++ : stats.otherVotesDown++;
    }
  });
}

// Saving to storage

// Each update reads a value, changes it and saves it back, so updates have to run
// one at a time. Otherwise two updates landing together would overwrite each other.
let storageQueue: Promise<void> = Promise.resolve();

/**
 * Queues a read-change-save update to one storage key. Updates run one at a time.
 * normalize fills in missing fields, so adding a new field later doesn't break old saved data.
 * @param key
 * @param normalize
 * @param update
 */
function queueUpdate<T extends object>(
  key: string,
  normalize: (stored: Partial<T> | undefined) => T,
  update: (value: T) => void,
): void {
  storageQueue = storageQueue
    .then(async () => {
      const result = await browser.storage.local.get(key);
      const value = normalize(result[key] as Partial<T> | undefined);
      update(value);
      await browser.storage.local.set({ [key]: value });
    })
    .catch((error) => console.error(`Failed to update ${key}:`, error));
}

// Dev stats

/**
 * Queues an update to the dev stats.
 * @param update
 */
function recordStats(update: (stats: DevStats) => void): void {
  queueUpdate(DEV_STATS_KEY, normalizeDevStats, update);
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
