// Types shared by the content script, background worker and popup.

export interface Ratings {
  imdbRating: string;
  rtRating: string;
  metacriticRating: string;
}

/** What the background worker sends back for a GET_RATINGS message. */
export type RatingsResponse =
  | { status: 'ok'; ratings: Ratings }
  | { status: 'not_found' }
  | { status: 'no_api_key' }
  | { status: 'error'; message: string };

export interface GetRatingsMessage {
  type: 'GET_RATINGS';
  payload: { title: string; year?: string };
}

/** Shape of each cache entry in storage. `ratings: null` means OMDb had no match. */
export interface CacheEntry {
  ratings: Ratings | null;
  cachedAt: number;
}

export const CACHE_PREFIX = 'cache_';
export const API_KEY_STORAGE_KEY = 'omdbApiKey';
