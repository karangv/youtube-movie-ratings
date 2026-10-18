import './style.css';
import { API_KEY_STORAGE_KEY, type GetRatingsMessage, type Ratings, type RatingsResponse } from '@/utils/ratings';

const MOVIE_SELECTOR = 'ytd-grid-movie-renderer';
const TITLE_SELECTOR = '#video-title';
const METADATA_SELECTOR = '.grid-movie-renderer-metadata';

const BADGE_CLASS = 'ymr-ratings';
// Stores the title a card was processed for, so we notice when YouTube reuses the card for another movie.
const PROCESSED_ATTR = 'data-ratings-title';
const SCAN_INTERVAL_MS = 500;
const MAX_CONCURRENT_REQUESTS = 4;

type Movie = { title: string; year?: string };
type BadgeState = RatingsResponse | { status: 'loading' };

export default defineContentScript({
  matches: ['*://*.youtube.com/*'],
  main(ctx) {
    console.log('Youtube Movie Ratings content script loaded');
    findAndProcessMovies();

    // YouTube changes the DOM almost constantly, so a debounce might never fire.
    // Throttle instead: scan at most once every SCAN_INTERVAL_MS while things are changing.
    let scanScheduled = false;
    const observer = new MutationObserver(() => {
      if (scanScheduled) return;
      scanScheduled = true;
      ctx.setTimeout(() => {
        scanScheduled = false;
        findAndProcessMovies();
      }, SCAN_INTERVAL_MS);
    });
    observer.observe(document.body, { childList: true, subtree: true });

    // YouTube fires this after every in-app (SPA) navigation.
    document.addEventListener('yt-navigate-finish', findAndProcessMovies);

    // When the API key is added or changed in the popup, redo every card on the page.
    const onStorageChanged = (changes: Record<string, unknown>, areaName: string) => {
      if (areaName === 'local' && API_KEY_STORAGE_KEY in changes) {
        reprocessAll();
      }
    };
    browser.storage.onChanged.addListener(onStorageChanged);

    // Clean up when the extension is reloaded or updated while the tab stays open.
    ctx.onInvalidated(() => {
      observer.disconnect();
      document.removeEventListener('yt-navigate-finish', findAndProcessMovies);
      browser.storage.onChanged.removeListener(onStorageChanged);
    });
  },
});

function findAndProcessMovies(): void {
  const movieElements = document.querySelectorAll(MOVIE_SELECTOR);
  for (const element of movieElements) {
    const movie = extractMovie(element);
    if (!movie) continue;
    if (element.getAttribute(PROCESSED_ATTR) === movie.title) continue;

    element.setAttribute(PROCESSED_ATTR, movie.title);
    renderBadge(element, { status: 'loading' });
    enqueue(() => processMovie(element, movie));
  }
}

function reprocessAll(): void {
  for (const element of document.querySelectorAll(`[${PROCESSED_ATTR}]`)) {
    element.removeAttribute(PROCESSED_ATTR);
  }
  findAndProcessMovies();
}

/** Reads the movie title and release year out of a YouTube movie card. */
function extractMovie(element: Element): Movie | null {
  const title = element.querySelector(TITLE_SELECTOR)?.getAttribute('title')?.trim();
  if (!title) return null;

  // Metadata looks like "Drama • 2019"; grab the first 4-digit year in it.
  const metadata = element.querySelector(METADATA_SELECTOR)?.textContent ?? '';
  const year = metadata.match(/\b(19|20)\d{2}\b/)?.[0];
  return { title, year };
}

async function processMovie(element: Element, movie: Movie): Promise<void> {
  const message: GetRatingsMessage = { type: 'GET_RATINGS', payload: movie };
  let response: RatingsResponse;
  try {
    response = await browser.runtime.sendMessage(message);
  } catch (error) {
    // Usually means the extension was reloaded while this tab was open.
    response = { status: 'error', message: 'Extension was reloaded. Refresh the page.' };
  }
  if (!response) {
    response = { status: 'error', message: 'No response from background worker' };
  }

  // The card may have been reused for a different movie while we were waiting.
  if (element.getAttribute(PROCESSED_ATTR) !== movie.title) return;
  renderBadge(element, response);
}

// ---- Request queue: keeps us from firing 30+ OMDb requests at once on a full page ----

const queue: (() => Promise<void>)[] = [];
let activeRequests = 0;

function enqueue(task: () => Promise<void>): void {
  queue.push(task);
  runQueue();
}

function runQueue(): void {
  while (activeRequests < MAX_CONCURRENT_REQUESTS && queue.length > 0) {
    const task = queue.shift()!;
    activeRequests++;
    task().finally(() => {
      activeRequests--;
      runQueue();
    });
  }
}

// ---- Badge rendering ----

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

/** Returns null when the rating is missing so we don't show empty "N/A" pills. */
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

/** Same thresholds Metacritic uses for its green/yellow/red colors. */
function metacriticClass(score: number): string {
  if (score >= 61) return 'ymr-mc-good';
  if (score >= 40) return 'ymr-mc-mixed';
  return 'ymr-mc-bad';
}

function createNote(text: string): HTMLElement {
  const note = document.createElement('span');
  note.className = 'ymr-note';
  note.textContent = text;
  return note;
}
