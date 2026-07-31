import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';

function flushAsyncWork() {
	return new Promise((resolve) => setImmediate(resolve));
}

function getInlineSearchScript() {
	const source = readFileSync(resolve('src/pages/search.astro'), 'utf8');
	const match = source.match(/<script is:inline>([\s\S]*?)<\/script>/);
	assert.ok(match, 'search page should include an inline script');
	return match[1];
}

async function runSearchScript({ inputValue = '', searchResults = [] } = {}) {
	const listeners = new Map();
	const inputListeners = new Map();
	let loaderScript;
	const calls = [];

	const input = {
		value: inputValue,
		addEventListener(type, listener) {
			inputListeners.set(type, listener);
		},
	};
	const results = { innerHTML: '' };
	const document = {
		getElementById(id) {
			if (id === 'search-input') return input;
			if (id === 'search-results') return results;
			return null;
		},
		createElement(tagName) {
			return { tagName, type: '', textContent: '' };
		},
		head: {
			appendChild(element) {
				loaderScript = element;
			},
		},
	};
	const window = {
		_pfSearch: async (query) => {
			calls.push(query);
			return { results: searchResults };
		},
		addEventListener(type, listener) {
			listeners.set(type, listener);
		},
		dispatchEvent(event) {
			return listeners.get(event.type)?.(event);
		},
	};

	vm.runInNewContext(getInlineSearchScript(), {
		document,
		window,
		Event: class Event {
			constructor(type) {
				this.type = type;
			}
		},
		Promise,
		setTimeout: (fn) => {
			fn();
			return 1;
		},
		clearTimeout: () => {},
	});

	await flushAsyncWork();

	return { calls, input, inputListeners, listeners, loaderScript, results, window };
}

test('Pagefind loader uses a module script with dynamic import error handling', async () => {
	const page = await runSearchScript();

	assert.equal(page.loaderScript.type, 'module');
	assert.match(page.loaderScript.textContent, /await import\("\/pagefind\/pagefind\.js"\)/);
	assert.match(page.loaderScript.textContent, /pagefind:ready/);
	assert.match(page.loaderScript.textContent, /pagefind:error/);
});

test('search reruns when Pagefind becomes ready after the user typed a query', async () => {
	const results = Array.from({ length: 12 }, (_, index) => ({
		data: async () => ({
			url: `/post-${index}`,
			meta: { title: `Post ${index}` },
			excerpt: `Excerpt ${index}`,
		}),
	}));
	const page = await runSearchScript({ inputValue: ' astro ', searchResults: results });

	page.window.dispatchEvent(new Event('pagefind:ready'));
	await flushAsyncWork();

	assert.deepEqual(page.calls, ['astro']);
	assert.match(page.results.innerHTML, /href="\/post-0"/);
	assert.match(page.results.innerHTML, /Post 9/);
	assert.doesNotMatch(page.results.innerHTML, /Post 10/);
});

test('search error state tells users to build the Pagefind index', async () => {
	const page = await runSearchScript();

	page.window.dispatchEvent(new Event('pagefind:error'));

	assert.match(page.results.innerHTML, /npm run build/);
});
