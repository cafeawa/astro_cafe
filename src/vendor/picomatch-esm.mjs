// ESM wrapper for picomatch.
//
// Astro 7's content sync (`astro sync`, used by `astro build`/`check`/`dev`)
// hardcodes `ssr.external: []` and inlines every dependency through Vite's SSR
// module runner. That runner evaluates inline modules as ESM, so a pure-CommonJS
// package like picomatch (no `exports`/`module`/`type: module` field, with
// `require()` at the top of index.js) throws `require is not defined`.
//
// This module is aliased to `picomatch` via `vite.resolve.alias` in
// astro.config.mjs, so the module runner sees a normal ESM module. Loading the
// real CommonJS through `createRequire` lets Node handle the CJS interop itself.
import { createRequire } from 'node:module';

const requireFromProject = createRequire(import.meta.url);
// pnpm keeps picomatch inside astro's own `node_modules` (it is not hoisted to the
// project root), so scope resolution to the astro package directory.
const astroMain = requireFromProject.resolve('astro');
const requireFromAstro = createRequire(astroMain);

const picomatch = requireFromAstro('picomatch');

export default picomatch;
export const makeRe = picomatch.makeRe;
export const isMatch = picomatch.isMatch;
export const scan = picomatch.scan;
export const parse = picomatch.parse;
export const constants = picomatch.constants;
