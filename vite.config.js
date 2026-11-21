import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import fs from 'node:fs/promises';
import path from 'node:path';

function ghPagesNoJekyllPlugin() {
  return {
    name: 'gh-pages-nojekyll',
    async closeBundle() {
      await fs.mkdir('docs', { recursive: true });
      await fs.writeFile(path.join('docs', '.nojekyll'), '');
    }
  };
}

export default defineConfig({
  plugins: [svelte(), ghPagesNoJekyllPlugin()],
  base: './',
  build: {
    outDir: 'docs',
    emptyOutDir: true
  }
});
