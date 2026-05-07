import { useEffect, useState } from 'react';

function App() {
  const [apiKey, setApiKey] = useState('');
  const [status, setStatus] = useState('idle');
  useEffect(() => {
    // Load the API key from storage when the component mounts
    browser.storage.local.get('omdbApiKey').then((result) => {
      if (result.omdbApiKey) {
        setApiKey(result.omdbApiKey as string);
        setStatus('loaded');
      }
    });
  }, []);

  const handleSave = async () => {
    if (apiKey.trim() === '') {
      setStatus('Enter your OMDB API key to get started');
      return;
    }
    // Save the API key to storage
    await browser.storage.local.set({ omdbApiKey: apiKey });
    setStatus('saved');
  };

  return (
   <div>
      <h1>Youtube Movie Ratings</h1>
      <p>Enter your OMDB API key to get movie ratings on Youtube.</p>
      <input
        type="text"
        placeholder="Enter OMDB API Key"
        value={apiKey}
        onChange={(e) => setApiKey(e.target.value)}
      />
      <button onClick={handleSave}>Save API Key</button>
      <p>Status: {status}</p>
   </div>
  );
}

export default App;
