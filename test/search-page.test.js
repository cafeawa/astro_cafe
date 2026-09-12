import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';

function flushAsyncWork() {
	return new Promise((resolve) => setImmediate(resolve));
}

function getInlineSearchScript() {
	const source = readFileSync(resolve('src/components/HeaderSearch.astro'), 'utf8');
	const match = source.match(/<script is:inline>([\s\S]*?)<\/script>/);
	assert.ok(match, 'search page should include an inline script');
	return match[1];
}

async function runSearchScript({ inputValue = '', searchResults = [], ready = false } = {}) {
	const listeners = new Map();
	const inputListeners = new Map();
	let loaderScript;
	const calls = [];
	const rootListeners = new Map();
	const documentListeners = new Map();
	const triggerListeners = new Map();
	const closeListeners = new Map();
	let focused;
	const trigger = {
		setAttribute() {},
		addEventListener: (type, listener) => triggerListeners.set(type, listener),
		focus: () => { focused = 'trigger'; },
	};
	const root = {
		dataset: { expanded: 'false', results: 'false' },
		contains: (target) => [input, trigger, closeButton, results].includes(target),
		addEventListener: (type, listener) => rootListeners.set(type, listener),
	};
	const panel = {
		attributes: {},
		setAttribute(name, value) { this.attributes[name] = value; },
	};
	const closeButton = {
		attributes: {},
		tabIndex: -1,
		setAttribute(name, value) { this.attributes[name] = value; },
		addEventListener: (type, listener) => closeListeners.set(type, listener),
	};

	const input = {
		value: inputValue,
		attributes: {},
		tabIndex: -1,
		setAttribute(name, value) { this.attributes[name] = value; },
		focus: () => { focused = 'input'; },
		addEventListener(type, listener) {
			inputListeners.set(type, listener);
		},
	};
	const results = {
		innerHTML: '',
		attributes: {},
		setAttribute(name, value) { this.attributes[name] = value; },
	};
	const document = {
		readyState: 'complete',
		activeElement: null,
		addEventListener: (type, listener) => documentListeners.set(type, listener),
		querySelectorAll: () => [trigger],
		querySelector: () => null,
		getElementById(id) {
			if (id === 'header-search') return root;
			if (id === 'search-toggle') return trigger;
			if (id === 'search-panel') return panel;
			if (id === 'search-close') return closeButton;
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
		_pfSearch: ready ? async (query) => {
			calls.push(query);
			return { results: searchResults };
		} : undefined,
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

	return { calls, input, inputListeners, listeners, results, window, root, rootListeners, closeListeners, panel, document, documentListeners,
		open: () => triggerListeners.get('click')(),
		get loaderScript() { return loaderScript; },
		get focused() { return focused; },
	};
}

test('Pagefind loader uses a module script with dynamic import error handling', async () => {
	const page = await runSearchScript();
	assert.equal(page.loaderScript, undefined, 'index only loads when the search expands');
	page.open();

	assert.equal(page.loaderScript.type, 'module');
	assert.match(page.loaderScript.textContent, /await import\("\/pagefind\/pagefind\.js"\)/);
	assert.match(page.loaderScript.textContent, /pagefind:ready/);
	assert.match(page.loaderScript.textContent, /pagefind:error/);
});

test('results extend from the same search surface and render as a connected list', () => {
	const source = readFileSync(resolve('src/components/HeaderSearch.astro'), 'utf8');
	assert.match(source, /class="search-surface"[\s\S]*class="search-bar"[\s\S]*id="search-panel"/);
	assert.match(source, /class="search-result"/);
	assert.doesNotMatch(source, /class="flat-card/);
	assert.match(source, /grid-template-rows 170ms/);
	assert.match(source, /right 180ms/);
	assert.match(source, /border-radius: 1\.125rem/);
	assert.doesNotMatch(source, /data-results='true'[^}]*border-radius/);
});

test('header content fades smoothly when the expanding search overlaps it', () => {
	const source = readFileSync(resolve('src/components/Header.astro'), 'utf8');
	assert.match(source, /\.header-brand-group\s*{[\s\S]*transition: opacity 110ms/);
	assert.match(source, /header:has\(\.header-search\[data-expanded='true'\]\)[\s\S]*opacity: 0/);
	assert.doesNotMatch(source, /header:has\(\.header-search\[data-expanded='true'\]\)[^}]*visibility:\s*hidden/);
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
	page.open();
	page.window._pfSearch = async (query) => { page.calls.push(query); return { results }; };

	page.window.dispatchEvent(new Event('pagefind:ready'));
	await flushAsyncWork();

	assert.deepEqual(page.calls, ['astro']);
	assert.match(page.results.innerHTML, /href="\/post-0"/);
	assert.match(page.results.innerHTML, /Post 9/);
	assert.doesNotMatch(page.results.innerHTML, /Post 10/);
});

test('search index failure shows a visitor-facing error and retries on reopen', async () => {
	const page = await runSearchScript({ inputValue: 'astro' });
	page.open();
	const firstLoader = page.loaderScript;
	page.window.dispatchEvent(new Event('pagefind:error'));
	assert.match(page.results.innerHTML, /搜索暂时不可用/);
	page.closeListeners.get('click')();
	page.open();
	assert.notEqual(page.loaderScript, firstLoader);
});

test('click expands and focuses input without displaying results until typing', async () => {
	const page = await runSearchScript();
	page.open();
	assert.equal(page.root.dataset.expanded, 'true');
	assert.equal(page.focused, 'input');
	assert.equal(page.root.dataset.results, 'false');
	page.closeListeners.get('click')();
	assert.equal(page.root.dataset.expanded, 'false');
	assert.equal(page.focused, 'trigger');
	assert.equal(page.input.tabIndex, -1);
});

test('outside click collapses search while clicking inside keeps it open', async () => {
	const page = await runSearchScript();
	page.open();
	page.documentListeners.get('pointerdown')({ target: page.input });
	assert.equal(page.root.dataset.expanded, 'true');
	page.documentListeners.get('pointerdown')({ target: {} });
	assert.equal(page.root.dataset.expanded, 'false');
});

test('Escape closes a populated search field but does not interrupt Chinese composition', async () => {
	const page = await runSearchScript({ inputValue: 'astro' });
	page.open();
	page.rootListeners.get('keydown')({ key: 'Escape', isComposing: true });
	assert.equal(page.root.dataset.expanded, 'true');
	let prevented = false;
	page.rootListeners.get('keydown')({ key: 'Escape', isComposing: false, preventDefault: () => { prevented = true; } });
	assert.equal(page.root.dataset.expanded, 'false');
	assert.equal(prevented, true);
	assert.equal(page.input.value, 'astro');
});

test('clearing the query prevents an older pending search from replacing the empty state', async () => {
	const page = await runSearchScript({ ready: true });
	page.open();
	let finishSearch;
	page.window._pfSearch = () => new Promise((resolve) => { finishSearch = resolve; });
	page.input.value = 'astro';
	page.inputListeners.get('input')({ isComposing: false });
	assert.equal(page.root.dataset.results, 'true');
	page.input.value = '';
	page.inputListeners.get('input')({ isComposing: false });
	assert.equal(page.root.dataset.results, 'false');
	finishSearch({ results: [{ data: async () => ({ url: '/old-result', meta: { title: 'Old result' } }) }] });
	await flushAsyncWork();
	assert.equal(page.results.innerHTML, '');
	assert.doesNotMatch(page.results.innerHTML, /Old result/);
});

test('switching queries keeps the current results visible until replacements are ready', async () => {
	const firstResults = [{
		data: async () => ({ url: '/first', meta: { title: 'First result' }, excerpt: 'First excerpt' }),
	}];
	const page = await runSearchScript({ ready: true, searchResults: firstResults });
	page.open();
	page.input.value = 'first';
	page.inputListeners.get('input')({ isComposing: false });
	await flushAsyncWork();
	assert.match(page.results.innerHTML, /First result/);

	let finishSearch;
	page.window._pfSearch = () => new Promise((resolve) => { finishSearch = resolve; });
	page.input.value = 'second';
	page.inputListeners.get('input')({ isComposing: false });
	assert.match(page.results.innerHTML, /First result/);
	assert.equal(page.results.attributes['aria-busy'], 'true');

	finishSearch({ results: [{
		data: async () => ({ url: '/second', meta: { title: 'Second result' }, excerpt: 'Second excerpt' }),
	}] });
	await flushAsyncWork();
	assert.match(page.results.innerHTML, /Second result/);
	assert.doesNotMatch(page.results.innerHTML, /正在搜索/);
	assert.equal(page.results.attributes['aria-busy'], 'false');
});

test('mouse hover expands without stealing focus; leaving an unused search collapses it', async () => {
	const page = await runSearchScript();
	page.rootListeners.get('pointerenter')({ pointerType: 'mouse' });
	assert.equal(page.root.dataset.expanded, 'true');
	assert.equal(page.focused, undefined);
	assert.equal(page.root.dataset.results, 'false');
	page.rootListeners.get('pointerleave')();
	assert.equal(page.root.dataset.expanded, 'false');
	page.rootListeners.get('pointerenter')({ pointerType: 'touch' });
	assert.equal(page.root.dataset.expanded, 'false');
});

test('a hover expansion can be interrupted and immediately reopened', async () => {
	const page = await runSearchScript();
	page.rootListeners.get('pointerenter')({ pointerType: 'mouse' });
	page.rootListeners.get('pointerleave')();
	page.open();
	assert.equal(page.root.dataset.expanded, 'true');
	assert.equal(page.input.tabIndex, 0);
	assert.equal(page.focused, 'input');
});

test('moving toward results keeps a populated search open and tabbing outside collapses it', async () => {
	const page = await runSearchScript({ inputValue: 'astro', ready: true });
	page.open();
	page.document.activeElement = page.input;
	page.rootListeners.get('pointerleave')();
	assert.equal(page.root.dataset.expanded, 'true');
	page.rootListeners.get('focusout')({ relatedTarget: page.results });
	assert.equal(page.root.dataset.expanded, 'true');
	page.rootListeners.get('focusout')({ relatedTarget: {} });
	assert.equal(page.root.dataset.expanded, 'false');
	assert.equal(page.root.dataset.results, 'false');
});

test('Chinese composition waits until the committed input before searching', async () => {
	const page = await runSearchScript({ ready: true });
	page.open();
	page.input.value = '文章';
	page.inputListeners.get('input')({ isComposing: true });
	assert.deepEqual(page.calls, []);
	page.inputListeners.get('compositionend')();
	await flushAsyncWork();
	assert.deepEqual(page.calls, ['文章']);
});
