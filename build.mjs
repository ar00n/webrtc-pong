import * as esbuild from 'esbuild';
import { minify as minifyHtml } from 'html-minifier-terser';
import fs from 'node:fs/promises';
import path from 'node:path';

const DIST = 'dist';

await fs.rm(DIST, { recursive: true, force: true });
await fs.mkdir(DIST, { recursive: true });

// 1. Bundle & minify JS (from a single entry point)
await esbuild.build({
  entryPoints: ['src/main.js'], // change to your main JS file
  bundle: true,
  minify: true,
  outfile: `${DIST}/app.min.js`,
});

// 2. Combine & minify all CSS files in ./styles
const styleFiles = (await fs.readdir('styles'))
  .filter((f) => f.endsWith('.css'))
  .sort();

await esbuild.build({
  stdin: {
    contents: styleFiles.map((f) => `@import "./styles/${f}";`).join('\n'),
    resolveDir: process.cwd(),
    loader: 'css',
  },
  bundle: true,
  minify: true,
  outfile: `${DIST}/styles.min.css`,
});

// 3. Rewrite & minify index.html
let html = await fs.readFile('index.html', 'utf8');

// Strip existing dev <link rel="stylesheet"> and <script> tags
html = html
  .replace(/<link\b[^>]*rel=["']stylesheet["'][^>]*>\s*/gi, '')
  .replace(/<script\b[^>]*>[\s\S]*?<\/script>\s*/gi, '');

// Inject the minified bundles
html = html
  .replace('</head>', '  <link rel="stylesheet" href="styles.min.css">\n</head>')
  .replace('</body>', '  <script src="app.min.js" defer></script>\n</body>');

const minifiedHtml = await minifyHtml(html, {
  collapseWhitespace: true,
  removeComments: true,
  minifyCSS: true,
  minifyJS: true,
});

await fs.writeFile(path.join(DIST, 'index.html'), minifiedHtml);
console.log('Build complete -> dist/');