import {
  API_KEY_STORAGE_KEY,
  CACHE_PREFIX,
  type CacheEntry,
  type GetRatingsMessage,
  type Ratings,
  type RatingsResponse,
} from '@/utils/ratings';

const FOUND_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const NOT_FOUND_TTL_MS = 24 * 60 * 60 * 1000; // 1 day, so we retry misses sooner

// Requests that are currently being fetched, keyed by cache key.
// If two cards ask for the same movie at once, they share one OMDb call.
const inFlight = new Map<string, Promise<RatingsResponse>>();

export default defineBackground(() => {
  console.log('Youtube Movie Ratings background script loaded', { id: browser.runtime.id });

  // Chrome ignores a Promise returned from this listener, so instead we
  // return `true` (keeps the channel open) and reply later via sendResponse.
  browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== 'GET_RATINGS') return false;

    handleGetRatings(message as GetRatingsMessage)
      .then(sendResponse)
      .catch((error) => sendResponse({ status: 'error', message: String(error) }));
    return true;
  });
});

async function handleGetRatings(message: GetRatingsMessage): Promise<RatingsResponse> {
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
      return cached.ratings ? { status: 'ok', ratings: cached.ratings } : { status: 'not_found' };
    }
  }

  let request = inFlight.get(cacheKey);
  if (!request) {
    request = fetchAndCache(cacheKey, cleanedTitle, year, omdbApiKey).finally(() => inFlight.delete(cacheKey));
    inFlight.set(cacheKey, request);
  }
  return request;
}

async function fetchAndCache(cacheKey: string, title: string, year: string | undefined, omdbApiKey: string): Promise<RatingsResponse> {
  const response = await fetchMovieRatings(title, year, omdbApiKey);
  // Only cache real answers. Errors (bad key, rate limit, network) should be retried.
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
 * Fetches movie ratings from the OMDB API. If the exact title + year isn't found it tries,
 * in order: the part of the title before a colon, then the full title without the year
 * (YouTube's year is sometimes off by one from OMDb's).
 * @param title
 * @param year
 * @param omdbApiKey
 * @returns ratings when found, `not_found` when OMDb has no match, or `error` for API/network problems.
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
    for (const attempt of attempts) {
      const omdbData = await queryOmdb(attempt.title, attempt.year, omdbApiKey);
      if (omdbData.Response === 'True') {
        return { status: 'ok', ratings: getRatings(omdbData) };
      }
      // Anything other than "not found" (bad key, rate limit) won't be fixed by retrying.
      if (omdbData.Error !== 'Movie not found!') {
        console.warn(`OMDB API error for ${title} (${year}):`, omdbData.Error);
        return { status: 'error', message: omdbData.Error ?? 'Unknown OMDb error' };
      }
    }
    return { status: 'not_found' };
  } catch (error) {
    console.error('Error fetching movie ratings:', error);
    return { status: 'error', message: 'Could not reach OMDb' };
  }
}

async function queryOmdb(title: string, year: string | undefined, omdbApiKey: string): Promise<any> {
  const params = new URLSearchParams({ t: title, type: 'movie', apikey: omdbApiKey });
  if (year) params.set('y', year);
  const omdbResponse = await fetch(`https://www.omdbapi.com/?${params}`);
  return omdbResponse.json();
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
