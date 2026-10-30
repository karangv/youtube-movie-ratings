// Types used by the content script, background and popup

export interface Ratings {
  imdbRating: string;
  rtRating: string;
  metacriticRating: string;
}

/** Response to a GET_RATINGS message */
export type RatingsResponse =
  | { status: 'ok'; ratings: Ratings }
  | { status: 'not_found' }
  | { status: 'no_api_key' }
  | { status: 'error'; message: string };

export interface GetRatingsMessage {
  type: 'GET_RATINGS';
  payload: { title: string; year?: string };
}

/** What gets saved in the cache. ratings is null when OMDb couldn't find the movie */
export interface CacheEntry {
  ratings: Ratings | null;
  cachedAt: number;
}

export const CACHE_PREFIX = 'cache_';
export const API_KEY_STORAGE_KEY = 'omdbApiKey';
