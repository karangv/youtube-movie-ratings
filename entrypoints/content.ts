export default defineContentScript({
  matches: ['*://*.youtube.com/*'],
  main() {
    console.log('Youtube Movie Ratings content script loaded');
    findAndProcessMovies();
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const observer = new MutationObserver(() => {
      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }
      debounceTimer = setTimeout(() => {
        findAndProcessMovies();
      }, 500);
    });
    observer.observe(document.body, { childList: true, subtree: true });
  },
});

async function findAndProcessMovies(): Promise<void>{
  let movieElements = document.querySelectorAll('ytd-grid-movie-renderer');
  for (const element of movieElements) {
    // Extract movie title and year from the element
    if (element.hasAttribute('data-ratings-processed')) continue;

    const titleElement = element.querySelector('#video-title')?.getAttribute('title');
    const yearElement = element.querySelector('.grid-movie-renderer-metadata')?.textContent.trim().split('•').pop()?.trim();

    if (!titleElement) continue;
    const ratings = await browser.runtime.sendMessage({
      type: 'GET_RATINGS',
      payload: {
        title: titleElement,
        year: yearElement} });
      console.log(ratings);
      element.setAttribute('data-ratings-processed', 'true');
    }
}
