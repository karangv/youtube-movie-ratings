// Types used by the content script, background and popup

export interface Ratings {
  imdbRating: string;
  rtRating: string;
  metacriticRating: string;
}

/** Movie details from OMDb, used for recommendations */
export interface MovieInfo {
  imdbId: string;
  genres: string[];
  directors: string[];
  actors: string[];
  year?: number;
}

/** Response to a GET_RATINGS message */
export type RatingsResponse =
  | { status: 'ok'; ratings: Ratings; info: MovieInfo }
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
  info: MovieInfo | null;
  cachedAt: number;
}

// Every cache key starts with this, so the popup can count and clear them
export const CACHE_PREFIX = 'cache_';
// Bump the version when CacheEntry changes so old entries get refetched
export const CACHE_KEY_PREFIX = `${CACHE_PREFIX}v2_`;
export const API_KEY_STORAGE_KEY = 'omdbApiKey';
