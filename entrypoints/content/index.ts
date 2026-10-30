import './style.css';
import { API_KEY_STORAGE_KEY, type GetRatingsMessage, type Ratings, type RatingsResponse } from '@/utils/ratings';
import type { RecordBatchMessage } from '@/utils/devStats';

const MOVIE_SELECTOR = 'ytd-grid-movie-renderer';
const TITLE_SELECTOR = '#video-title';
const METADATA_SELECTOR = '.grid-movie-renderer-metadata';

const BADGE_CLASS = 'ymr-ratings';
// Holds the title the card was processed for. YouTube reuses cards, so if the title changes we redo it.
const PROCESSED_ATTR = 'data-ratings-title';
const SCAN_INTERVAL_MS = 500;
const MAX_CONCURRENT_REQUESTS = 4;
// How close a card has to get to the screen before we load its ratings
const VISIBILITY_MARGIN = '300px 0px';

type Movie = { title: string; year?: string };
type BadgeState = RatingsResponse | { status: 'loading' };

// Only look up cards that are on (or close to) the screen. Some pages have hundreds of cards
// and fetching all of them eats through the 1,000 requests/day limit.
// It gets created in main() since WXT also imports this file at build time, where it doesn't exist.
let visibilityObserver: IntersectionObserver;

export default defineContentScript({
  matches: ['*://*.youtube.com/*'],
  main(ctx) {
    console.log('Youtube Movie Ratings content script loaded');
    visibilityObserver = new IntersectionObserver(onCardsVisible, { rootMargin: VISIBILITY_MARGIN });
    watchNewMovieCards();

    // YouTube changes the DOM pretty much constantly, so a debounce might never fire.
    // Throttling instead so we scan at most once every SCAN_INTERVAL_MS.
    let scanScheduled = false;
    const observer = new MutationObserver(() => {
      if (scanScheduled) return;
      scanScheduled = true;
      ctx.setTimeout(() => {
        scanScheduled = false;
        watchNewMovieCards();
      }, SCAN_INTERVAL_MS);
    });
    observer.observe(document.body, { childList: true, subtree: true });

    // YouTube fires this after navigating between pages
    document.addEventListener('yt-navigate-finish', watchNewMovieCards);

    // Redo all the cards if the API key changes
    const onStorageChanged = (changes: Record<string, unknown>, areaName: string) => {
      if (areaName === 'local' && API_KEY_STORAGE_KEY in changes) {
        reprocessAll();
      }
    };
    browser.storage.onChanged.addListener(onStorageChanged);

    // Clean up if the extension gets reloaded while the tab is still open
    ctx.onInvalidated(() => {
      observer.disconnect();
      visibilityObserver.disconnect();
      document.removeEventListener('yt-navigate-finish', watchNewMovieCards);
      browser.storage.onChanged.removeListener(onStorageChanged);
    });
  },
});

/**
 * Finds movie cards that are new (or now show a different movie) and starts watching them,
 * so their ratings get loaded once they're near the screen.
 */
function watchNewMovieCards(): void {
  const movieElements = document.querySelectorAll(MOVIE_SELECTOR);
  for (const element of movieElements) {
    const movie = extractMovie(element);
    if (!movie) continue;
    if (element.getAttribute(PROCESSED_ATTR) === movie.title) continue;

    element.setAttribute(PROCESSED_ATTR, movie.title);
    // Remove the old badge in case the card was reused for a different movie
    element.querySelector(`.${BADGE_CLASS}`)?.remove();
    // Look it up once it's near the screen. observe() does nothing if we're already
    // watching this card, otherwise onCardsVisible gets called right away.
    visibilityObserver.observe(element);
  }
}

/**
 * Called by the IntersectionObserver when watched cards come near the screen.
 * Queues a ratings lookup for each card that is now visible.
 * @param entries
 */
function onCardsVisible(entries: IntersectionObserverEntry[]): void {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    const element = entry.target;
    visibilityObserver.unobserve(element);

    // Skip it if the card got reused for a different movie in the meantime.
    // The next scan will pick up the new title.
    const movie = extractMovie(element);
    if (!movie || element.getAttribute(PROCESSED_ATTR) !== movie.title) continue;

    renderBadge(element, { status: 'loading' });
    enqueue(() => processMovie(element, movie));
  }
}

/**
 * Clears the processed flag on every card and scans again, so every card gets looked up again.
 */
function reprocessAll(): void {
  for (const element of document.querySelectorAll(`[${PROCESSED_ATTR}]`)) {
    element.removeAttribute(PROCESSED_ATTR);
  }
  watchNewMovieCards();
}

/**
 * Gets the title and year from a movie card.
 * @param element
 * @returns the title and year, or null if the card doesn't have a title yet.
 */
function extractMovie(element: Element): Movie | null {
  const title = element.querySelector(TITLE_SELECTOR)?.getAttribute('title')?.trim();
  if (!title) return null;

  // Metadata looks like "Drama • 2019" so just grab the year
  const metadata = element.querySelector(METADATA_SELECTOR)?.textContent ?? '';
  const year = metadata.match(/\b(19|20)\d{2}\b/)?.[0];
  return { title, year };
}

/**
 * Asks the background script for the movie's ratings and shows them on the card.
 * @param element
 * @param movie
 */
async function processMovie(element: Element, movie: Movie): Promise<void> {
  const message: GetRatingsMessage = { type: 'GET_RATINGS', payload: movie };
  let response: RatingsResponse;
  try {
    response = await browser.runtime.sendMessage(message);
  } catch (error) {
    // Usually means the extension got reloaded and the page needs a refresh
    response = { status: 'error', message: 'Extension was reloaded. Refresh the page.' };
  }
  if (!response) {
    response = { status: 'error', message: 'No response from background worker' };
  }

  if (response.status === 'ok' || response.status === 'not_found') {
    batchRatedCards++;
  }

  // Card might have been reused for a different movie while we were waiting
  if (element.getAttribute(PROCESSED_ATTR) !== movie.title) return;
  renderBadge(element, response);
}


// Limits how many lookups run at once so we don't flood OMDb

const queue: (() => Promise<void>)[] = [];
let activeRequests = 0;

// A batch starts when the queue goes from empty to busy and ends when it's empty again.
// Used for the timing numbers in the dev stats.
let batchStart = 0;
let batchRatedCards = 0;

/**
 * Adds a lookup to the queue and starts it if there's room.
 * Also starts timing a new batch if the queue was empty.
 * @param task
 */
function enqueue(task: () => Promise<void>): void {
  if (activeRequests === 0 && queue.length === 0) {
    batchStart = performance.now();
    batchRatedCards = 0;
  }
  queue.push(task);
  runQueue();
}

/**
 * Starts queued lookups until MAX_CONCURRENT_REQUESTS are running.
 */
function runQueue(): void {
  while (activeRequests < MAX_CONCURRENT_REQUESTS && queue.length > 0) {
    const task = queue.shift()!;
    activeRequests++;
    task().finally(() => {
      activeRequests--;
      runQueue();
      if (activeRequests === 0 && queue.length === 0) {
        reportBatch();
      }
    });
  }
}

/**
 * Sends how long the last batch took to the background script for the dev stats.
 */
function reportBatch(): void {
  // Ignore batches where nothing actually got rated (like when there's no API key)
  if (batchRatedCards === 0) return;
  const message: RecordBatchMessage = {
    type: 'RECORD_BATCH',
    payload: { cards: batchRatedCards, ms: performance.now() - batchStart },
  };
  browser.runtime.sendMessage(message).catch(() => {});
}


/**
 * Replaces the card's badge with one for the given state (loading, ratings, or a message).
 * @param element
 * @param state
 */
function renderBadge(element: Element, state: BadgeState): void {
  element.querySelector(`.${BADGE_CLASS}`)?.remove();

  const badge = document.createElement('div');
  badge.className = BADGE_CLASS;

  switch (state.status) {
    case 'loading':
      badge.append(createNote('Loading ratings…'));
      break;
    case 'ok':
      appendRatingPills(badge, state.ratings);
      break;
    case 'not_found':
      badge.append(createNote('No ratings found'));
      break;
    case 'no_api_key':
      badge.append(createNote('Add your OMDb API key in the extension popup'));
      break;
    case 'error':
      badge.append(createNote('Ratings unavailable'));
      badge.title = state.message;
      break;
  }

  const metadata = element.querySelector(METADATA_SELECTOR);
  if (metadata) {
    metadata.after(badge);
  } else {
    element.append(badge);
  }
}

/**
 * Adds the IMDb, RT and Metacritic pills to a badge, skipping any that are missing.
 * @param badge
 * @param ratings
 */
function appendRatingPills(badge: HTMLElement, ratings: Ratings): void {
  const rtScore = parseInt(ratings.rtRating, 10);
  const mcScore = parseInt(ratings.metacriticRating, 10);

  const pills = [
    createPill('IMDb', ratings.imdbRating, 'ymr-imdb', `IMDb: ${ratings.imdbRating}/10`),
    createPill('RT', ratings.rtRating, rtScore >= 60 ? 'ymr-rt-fresh' : 'ymr-rt-rotten', `Rotten Tomatoes: ${ratings.rtRating}`),
    createPill('MC', isNaN(mcScore) ? 'N/A' : String(mcScore), metacriticClass(mcScore), `Metacritic: ${ratings.metacriticRating}`),
  ].filter((pill) => pill !== null);

  if (pills.length === 0) {
    badge.append(createNote('No ratings found'));
  } else {
    badge.append(...pills);
  }
}

/**
 * Creates one rating pill, like "IMDb 7.8".
 * @param label
 * @param value
 * @param className
 * @param tooltip
 * @returns the pill element, or null if the rating is missing so we don't show "N/A" pills.
 */
function createPill(label: string, value: string, className: string, tooltip: string): HTMLElement | null {
  if (!value || value === 'N/A') return null;

  const pill = document.createElement('span');
  pill.className = `ymr-pill ${className}`;
  pill.title = tooltip;

  const labelElement = document.createElement('span');
  labelElement.className = 'ymr-label';
  labelElement.textContent = label;

  pill.append(labelElement, value);
  return pill;
}

/**
 * Picks the pill color for a Metacritic score, using the same cutoffs Metacritic uses.
 * @param score
 * @returns the CSS class name.
 */
function metacriticClass(score: number): string {
  if (score >= 61) return 'ymr-mc-good';
  if (score >= 40) return 'ymr-mc-mixed';
  return 'ymr-mc-bad';
}

/**
 * Creates a plain text note for the badge, like "No ratings found".
 * @param text
 * @returns the note element.
 */
function createNote(text: string): HTMLElement {
  const note = document.createElement('span');
  note.className = 'ymr-note';
  note.textContent = text;
  return note;
}
