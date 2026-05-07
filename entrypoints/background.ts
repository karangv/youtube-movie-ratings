export default defineBackground(() => {
  console.log('Youtube Movie Ratings background script loaded', { id: browser.runtime.id });
  browser.runtime.onMessage.addListener(async (message, sender) => {
    console.log('Received message in background:', message, sender);
    const result = await browser.storage.local.get('omdbApiKey')
    const omdbApiKey = result.omdbApiKey;
    if(!omdbApiKey) {
      console.warn('OMDB API key not found in storage');
      return;
    }
    if (message.type === 'GET_RATINGS') {
      const { title, year } = message.payload;
      const cacheKey = `cache_${title}_${year}`;
      const cachedRatings = await browser.storage.local.get(cacheKey);
      const cached = cachedRatings[cacheKey] as { ratings: { imdbRating: string, rtRating: string, metacriticRating: string }, cachedAt: number };
      if (cached) {
        // Check if the cached ratings are still valid (e.g., less than 7 days old)
        if (Date.now() - cached.cachedAt < 7 * 24 * 60 * 60 * 1000) {
          return cached.ratings;
        }
      }
      const ratings = await fetchMovieRatings(title, year, omdbApiKey as string);
      if(ratings) {
        await browser.storage.local.set({ [cacheKey]: { ratings, cachedAt: Date.now() } });
      }
      return ratings;
    }
});

async function fetchMovieRatings(title: string, year: string, omdbApiKey: string): Promise<{ imdbRating: string, rtRating: string, metacriticRating: string } | null> {
  try {
    const omdbResponse = await fetch(`https://www.omdbapi.com/?t=${encodeURIComponent(title)}&y=${encodeURIComponent(year)}&type=movie&apikey=${omdbApiKey}`);
    const omdbData = await omdbResponse.json();
    if (omdbData.Response === 'False') {
      console.warn(`OMDB API error for ${title} (${year}):`, omdbData.Error);
      return null;
    }
    
    const rtRating = omdbData.Ratings?.find((r: any) => r.Source === 'Rotten Tomatoes')?.Value || 'N/A';
    const metacriticRating = omdbData.Ratings?.find((r: any) => r.Source === 'Metacritic')?.Value || 'N/A';
    const imdbRating = omdbData.imdbRating || 'N/A';
  

    return { imdbRating, rtRating, metacriticRating};
  } catch (error) {
    console.error('Error fetching movie ratings:', error);
    return null;
  }
}});
