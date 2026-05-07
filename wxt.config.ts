import { defineConfig } from 'wxt';

// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'Youtube Movie Ratings',
    description: 'A extension to show movie ratings on Youtube.',
    version: '1.0.0',
    permissions: ["storage"],
    host_permissions: ["https://www.omdbapi.com/*", "https://api.themoviedb.org/*"],
  },
});
