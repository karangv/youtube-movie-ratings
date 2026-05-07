# YouTube Movie Ratings

A Chrome extension that displays IMDb, Rotten Tomatoes, and Metacritic ratings directly on YouTube movie cards.

## Features

- Shows IMDb, Rotten Tomatoes, and Metacritic ratings on YouTube movie browse pages
- Ratings are fetched via the [OMDb API](https://www.omdbapi.com/) using your own API key
- Results are cached locally for 7 days to minimize API calls
- Works on YouTube's movie storefront and top-selling pages

## Tech Stack

- [WXT](https://wxt.dev/) — Web Extension framework
- React + TypeScript
- OMDb API

## Setup

### Prerequisites

- [Node.js](https://nodejs.org/) (v18+)
- A free [OMDb API key](https://www.omdbapi.com/apikey.aspx)

### Install dependencies

```bash
npm install
```

### Run in development mode

```bash
npm run dev
```

Then load the extension in Chrome:
1. Go to `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked** and select the `.output/chrome-mv3` folder

### Configure your API key

1. Click the extension icon in Chrome
2. Enter your OMDb API key and click **Save API Key**

## Build for production

```bash
npm run build
```
