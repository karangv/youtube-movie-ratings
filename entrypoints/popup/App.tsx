import { useEffect, useState } from 'react';
import { API_KEY_STORAGE_KEY, CACHE_PREFIX } from '@/utils/ratings';
import { RECOMMENDATIONS_KEY, type RecommendationStore } from '@/utils/recommendations';
import DevStats from './DevStats';

type Status = { kind: 'idle' | 'info' | 'success' | 'error'; text: string };

/**
 * Popup for saving the OMDb API key and managing the cache.
 */
function App() {
  const [apiKey, setApiKey] = useState('');
  const [status, setStatus] = useState<Status>({ kind: 'idle', text: '' });
  const [saving, setSaving] = useState(false);
  const [cachedCount, setCachedCount] = useState(0);
  const [voteCounts, setVoteCounts] = useState({ up: 0, down: 0 });

  useEffect(() => {
    // Load the API key from storage when the component mounts
    browser.storage.local.get(API_KEY_STORAGE_KEY).then((result) => {
      if (result[API_KEY_STORAGE_KEY]) {
        setApiKey(result[API_KEY_STORAGE_KEY] as string);
        setStatus({ kind: 'success', text: 'API key saved. Ratings will show on YouTube movie pages.' });
      } else {
        setStatus({ kind: 'info', text: 'Enter your OMDb API key to get started.' });
      }
    });
    refreshCacheCount();
    refreshVoteCounts();
  }, []);

  const refreshCacheCount = async () => {
    const all = await browser.storage.local.get(null);
    setCachedCount(Object.keys(all).filter((key) => key.startsWith(CACHE_PREFIX)).length);
  };

  const refreshVoteCounts = async () => {
    const result = await browser.storage.local.get(RECOMMENDATIONS_KEY);
    const store = result[RECOMMENDATIONS_KEY] as RecommendationStore | undefined;
    const allVotes = Object.values(store?.votes ?? {});
    setVoteCounts({
      up: allVotes.filter((entry) => entry.vote === 1).length,
      down: allVotes.filter((entry) => entry.vote === -1).length,
    });
  };

  const handleSave = async () => {
    const trimmedKey = apiKey.trim();
    if (trimmedKey === '') {
      setStatus({ kind: 'error', text: 'Enter your OMDb API key to get started.' });
      return;
    }

    setSaving(true);
    setStatus({ kind: 'info', text: 'Checking key…' });
    const error = await validateApiKey(trimmedKey);
    setSaving(false);
    if (error) {
      setStatus({ kind: 'error', text: error });
      return;
    }

    // Save the API key to storage (open YouTube tabs update on their own)
    await browser.storage.local.set({ [API_KEY_STORAGE_KEY]: trimmedKey });
    setApiKey(trimmedKey);
    setStatus({ kind: 'success', text: 'API key saved. Ratings will show on YouTube movie pages.' });
  };

  const handleClearCache = async () => {
    const all = await browser.storage.local.get(null);
    const cacheKeys = Object.keys(all).filter((key) => key.startsWith(CACHE_PREFIX));
    await browser.storage.local.remove(cacheKeys);
    await refreshCacheCount();
  };

  const handleResetRecommendations = async () => {
    // Open YouTube tabs see this change and remove their "For you" pills
    await browser.storage.local.remove(RECOMMENDATIONS_KEY);
    await refreshVoteCounts();
  };

  return (
    <div className="popup">
      <h1>Youtube Movie Ratings</h1>
      <p>
        Enter your OMDb API key to get movie ratings on Youtube. Get a free key at{' '}
        <a href="https://www.omdbapi.com/apikey.aspx" target="_blank" rel="noreferrer">
          omdbapi.com
        </a>
        .
      </p>

      <div className="row">
        <input
          type="text"
          placeholder="Enter OMDB API Key"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSave()}
          spellCheck={false}
        />
        <button onClick={handleSave} disabled={saving}>
          {saving ? 'Checking…' : 'Save'}
        </button>
      </div>
      {status.text && <p className={`status ${status.kind}`}>{status.text}</p>}

      <hr />

      <div className="row cache">
        <span>
          {cachedCount} {cachedCount === 1 ? 'movie' : 'movies'} cached
        </span>
        <button onClick={handleClearCache} disabled={cachedCount === 0}>
          Clear cache
        </button>
      </div>

      <div className="row cache">
        <span>
          {voteCounts.up} 👍 · {voteCounts.down} 👎
        </span>
        <button onClick={handleResetRecommendations} disabled={voteCounts.up + voteCounts.down === 0}>
          Reset recommendations
        </button>
      </div>

      <DevStats />
    </div>
  );
}

/**
 * Checks the API key with a quick OMDb request.
 * @param apiKey 
 * @returns an error message, or null if the key works.
 */
async function validateApiKey(apiKey: string): Promise<string | null> {
  try {
    // tt0111161 is The Shawshank Redemption, any valid IMDb id would work
    const response = await fetch(`https://www.omdbapi.com/?i=tt0111161&apikey=${encodeURIComponent(apiKey)}`);
    const data = await response.json();
    if (data.Response === 'True') return null;
    return data.Error === 'Invalid API key!' ? 'That API key is not valid.' : `OMDb error: ${data.Error}`;
  } catch {
    return 'Could not reach OMDb. Check your connection and try again.';
  }
}

export default App;
