// @ts-check

import mdx from '@astrojs/mdx';
import sitemap from '@astrojs/sitemap';
import { defineConfig, fontProviders } from 'astro/config';
import { fileURLToPath } from 'node:url';

import tailwindcss from '@tailwindcss/vite';

// https://astro.build/config
export default defineConfig({
  site: 'https://example.com',
  integrations: [mdx(), sitemap()],

  fonts: [
      {
          provider: fontProviders.local(),
          name: 'Atkinson',
          cssVariable: '--font-atkinson',
          fallbacks: ['sans-serif'],
          options: {
              variants: [
                  {
                      src: ['./src/assets/fonts/atkinson-regular.woff'],
                      weight: 400,
                      style: 'normal',
                      display: 'swap',
                  },
                  {
                      src: ['./src/assets/fonts/atkinson-bold.woff'],
                      weight: 700,
                      style: 'normal',
                      display: 'swap',
                  },
              ],
          },
      },
	],

  vite: {
    plugins: [tailwindcss()],
    resolve: {
      alias: [
        // Workaround: picomatch is pure CommonJS (no ESM build / `exports` field).
        // Astro content sync inlines deps through Vite's SSR module runner, which
        // evaluates pure-CJS modules as ESM → "require is not defined". Redirect to
        // our ESM wrapper so picomatch loads via the module runner without issue.
        // See src/vendor/picomatch-esm.mjs
        {
          find: 'picomatch',
          replacement: fileURLToPath(new URL('./src/vendor/picomatch-esm.mjs', import.meta.url)),
        },
      ],
    },
  },
});