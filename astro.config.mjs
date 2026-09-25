// @ts-check

import mdx from '@astrojs/mdx';
import sitemap from '@astrojs/sitemap';
import { defineConfig, fontProviders } from 'astro/config';
import { fileURLToPath } from 'node:url';

import tailwindcss from '@tailwindcss/vite';

// https://astro.build/config
export default defineConfig({
  site: 'https://www.cafenya.top',
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
    server: {
      watch: {
        // .preview/ 是开发期的截图产物目录。dev server 默认监听整个项目，
        // 截图写文件（以及误留在里面的浏览器 profile）会不停触发 program reload，
        // 把 dev server 拖到假死（实测：改这个之前它 22s 才响应一次）。这里直接排除。
        ignored: ['**/.preview/**'],
      },
    },
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
