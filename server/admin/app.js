/* 文章控制台前端 —— 无框架、无构建步骤，直接由 server/admin.js 提供 */

const el = (id) => document.getElementById(id);

const state = {
	posts: [],
	meta: null,
	current: null, // 当前编辑的文章元信息；exists=false 表示还没落盘
	hero: null, // 封面图：项目相对路径（src/assets/...）或 '.' 开头的原始写法
	dirty: false,
	slugTouched: false,
	search: '',
	autoSaveTimer: null,
	dev: { running: false, url: null },
	busy: false,
};

/* ---------------- 小工具 ---------------- */

const SLUG_STRIP = /[^a-z0-9\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/g;

function slugify(value) {
	return String(value ?? '')
		.normalize('NFKC')
		.toLowerCase()
		.replace(/['"‘’“”]/g, '')
		.replace(SLUG_STRIP, '-')
		.replace(/-{2,}/g, '-')
		.replace(/^-+|-+$/g, '');
}

function todayIso() {
	const now = new Date();
	const pad = (n) => String(n).padStart(2, '0');
	return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

let toastTimer;
function toast(message, kind = 'info') {
	const node = el('toast');
	node.textContent = message;
	node.dataset.kind = kind;
	node.hidden = false;
	clearTimeout(toastTimer);
	toastTimer = setTimeout(() => {
		node.hidden = true;
	}, kind === 'error' ? 7000 : 2600);
}

async function api(path, options) {
	const response = await fetch(path, options);
	const text = await response.text();
	let payload = null;
	try {
		payload = text ? JSON.parse(text) : null;
	} catch {
		payload = null;
	}
	if (!response.ok) throw new Error(payload?.error ?? `${response.status} ${response.statusText}`);
	return payload;
}

const getJSON = (path) => api(path);
const postJSON = (path, body) =>
	api(path, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body ?? {}),
	});

/** 读取服务端 SSE（fetch + ReadableStream），返回退出码 */
async function streamPost(path, body, handlers = {}) {
	const response = await fetch(path, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body ?? {}),
	});
	if (!response.ok) {
		const text = await response.text();
		let message = `${response.status} ${response.statusText}`;
		try {
			message = JSON.parse(text).error ?? message;
		} catch {
			/* 保持默认信息 */
		}
		throw new Error(message);
	}

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	let exitCode = null;

	for (;;) {
		const { value, done } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });

		let index;
		while ((index = buffer.indexOf('\n\n')) >= 0) {
			const chunk = buffer.slice(0, index);
			buffer = buffer.slice(index + 2);

			let event = 'message';
			let data = '';
			for (const line of chunk.split('\n')) {
				if (line.startsWith('event:')) event = line.slice(6).trim();
				else if (line.startsWith('data:')) data += line.slice(5).trim();
			}
			if (!data) continue;

			let payload;
			try {
				payload = JSON.parse(data);
			} catch {
				continue;
			}
			if (event === 'exit') exitCode = payload.code;
			handlers[event]?.(payload);
		}
	}

	return exitCode;
}

function appendLog(node, line) {
	node.textContent += `${line}\n`;
	node.scrollTop = node.scrollHeight;
}

/* ---------------- 状态 ---------------- */

function setDirty(value) {
	state.dirty = value;
	const node = el('save-state');
	node.dataset.dirty = String(value);
	node.textContent = value ? '● 有未保存改动' : '已保存';
}

function markDirty() {
	setDirty(true);
	scheduleAutoSave();
}

function confirmDiscard() {
	if (!state.dirty) return true;
	return window.confirm('当前文章有未保存的改动，确定要放弃吗？');
}

/* ---------------- 文章列表 ---------------- */

async function refreshPosts() {
	const { posts } = await getJSON('/api/posts');
	state.posts = posts;
	renderList();
	renderTagOptions();
}

function renderList() {
	const list = el('post-list');
	const term = state.search.trim().toLowerCase();
	const posts = state.posts.filter((post) => {
		if (!term) return true;
		return [post.title, post.slug, post.tags.join(' ')].join(' ').toLowerCase().includes(term);
	});

	el('post-count').textContent = `${posts.length} / ${state.posts.length} 篇`;
	list.replaceChildren();

	for (const post of posts) {
		const item = document.createElement('button');
		item.type = 'button';
		item.className = 'post-item';
		item.dataset.active = String(state.current?.slug === post.slug);

		const title = document.createElement('div');
		title.className = 'title';
		title.append(post.title);
		if (post.draft) {
			const badge = document.createElement('span');
			badge.className = 'badge';
			badge.textContent = '草稿';
			title.append(badge);
		}

		const meta = document.createElement('div');
		meta.className = 'meta';
		const tags = post.tags.length ? ` · ${post.tags.map((tag) => `#${tag}`).join(' ')}` : '';
		meta.textContent = `${post.pubDate ?? '无日期'} · ${post.slug}${tags}`;

		item.append(title, meta);
		item.addEventListener('click', () => openPost(post.slug));
		list.append(item);
	}
}

function renderTagOptions() {
	const tags = [...new Set(state.posts.flatMap((post) => post.tags))].sort();
	const datalist = el('tag-options');
	datalist.replaceChildren();
	for (const tag of tags) {
		const option = document.createElement('option');
		option.value = tag;
		datalist.append(option);
	}
}

/* ---------------- 编辑 ---------------- */

function applyForm(post) {
	el('f-title').value = post.title ?? '';
	el('f-slug').value = post.slug ?? '';
	el('f-desc').value = post.description ?? '';
	el('f-date').value = post.pubDate ?? todayIso();
	el('f-updated').value = post.updatedDate ?? '';
	el('f-tags').value = (post.tags ?? []).join(', ');
	el('f-draft').checked = Boolean(post.draft);
	el('f-mdx').checked = Boolean(post.mdx);
	el('f-body').value = post.body ?? '';
	el('empty').hidden = true;
	el('editor-body').hidden = false;
	updateCover();
	updateBodyStats();
}

/** 保存成功后只回填服务端改过的字段，不动正文，避免覆盖用户正在敲的内容 */
function applyMeta(post) {
	el('f-slug').value = post.slug;
	el('f-mdx').checked = Boolean(post.mdx);
	updateCover();
}

function updateCover() {
	const name = el('cover-name');
	const thumb = el('cover-thumb');
	if (!state.hero) {
		name.textContent = '未设置';
		thumb.hidden = true;
		thumb.removeAttribute('src');
		return;
	}
	name.textContent = state.hero;
	if (state.hero.startsWith('src/')) {
		thumb.src = `/asset?path=${encodeURIComponent(state.hero)}`;
		thumb.hidden = false;
	} else {
		thumb.hidden = true;
	}
}

function updateBodyStats() {
	const text = el('f-body').value;
	el('body-stats').textContent = `${text.length} 字 · ${text.split('\n').length} 行`;
}

async function openPost(slug) {
	if (!confirmDiscard()) return;
	try {
		const { post } = await getJSON(`/api/post?slug=${encodeURIComponent(slug)}`);
		state.current = { ...post, exists: true };
		state.hero = post.heroAsset ?? post.heroImage ?? null;
		state.slugTouched = true; // 已有文章的 slug 不跟着标题自动改，避免悄悄换 URL
		applyForm(post);
		setDirty(false);
		renderList();
		renderAssetsActive();
		refreshPreview();
	} catch (error) {
		toast(error.message, 'error');
	}
}

function newPost() {
	if (!confirmDiscard()) return;
	state.current = { slug: '', exists: false };
	state.hero = null;
	state.slugTouched = false;
	applyForm({
		title: '',
		slug: '',
		description: '',
		pubDate: todayIso(),
		updatedDate: null,
		tags: [],
		draft: false,
		mdx: false,
		body: state.meta?.defaultBody ?? '',
	});
	setDirty(false);
	renderList();
	renderAssetsActive();
	el('f-title').focus();
	refreshPreview();
}

function collectPayload() {
	const current = state.current ?? {};
	return {
		originalSlug: current.exists ? current.slug : null,
		title: el('f-title').value.trim(),
		slug: el('f-slug').value.trim(),
		description: el('f-desc').value,
		pubDate: el('f-date').value || todayIso(),
		updatedDate: el('f-updated').value || null,
		tags: el('f-tags').value,
		draft: el('f-draft').checked,
		mdx: el('f-mdx').checked,
		heroImage: state.hero,
		body: el('f-body').value,
	};
}

async function savePost({ silent = false } = {}) {
	if (state.busy) return;
	const payload = collectPayload();
	if (!payload.title) {
		toast('标题不能为空', 'error');
		el('f-title').focus();
		return;
	}

	const current = state.current ?? {};
	if (current.exists && payload.slug && payload.slug !== current.slug) {
		const ok = window.confirm(`slug 从 ${current.slug} 改成 ${payload.slug}：URL 会变，旧链接会 404。继续？`);
		if (!ok) return;
	}

	state.busy = true;
	try {
		const { post } = await postJSON('/api/post', payload);
		state.current = { ...post, exists: true };
		state.hero = post.heroAsset ?? post.heroImage ?? null;
		state.slugTouched = true;
		applyMeta(post);
		setDirty(false);
		if (!silent) toast('已保存');
		await refreshPosts();
		renderAssetsActive();
		refreshPreview();
	} catch (error) {
		toast(error.message, 'error');
	} finally {
		state.busy = false;
	}
}

async function deletePost() {
	const current = state.current;
	if (!current?.exists) {
		toast('这篇还没保存过，清空表单即可');
		return;
	}
	const ok = window.confirm(`删除《${current.title}》？${current.fileName} 会直接从磁盘删掉，没有回收站。`);
	if (!ok) return;

	try {
		await postJSON('/api/post/delete', { slug: current.slug });
		toast('已删除');
		state.current = null;
		state.hero = null;
		el('editor-body').hidden = true;
		el('empty').hidden = false;
		setDirty(false);
		await refreshPosts();
		refreshPreview();
	} catch (error) {
		toast(error.message, 'error');
	}
}

function scheduleAutoSave() {
	if (!el('autosave').checked || !state.current?.exists) return;
	clearTimeout(state.autoSaveTimer);
	state.autoSaveTimer = setTimeout(() => {
		if (state.dirty) savePost({ silent: true });
	}, 1200);
}

/* ---------------- 封面图 ---------------- */

async function refreshAssets() {
	const { assets } = await getJSON('/api/assets');
	const grid = el('asset-grid');
	grid.replaceChildren();

	if (!assets.length) {
		const empty = document.createElement('p');
		empty.className = 'muted';
		empty.textContent = 'src/assets/ 里还没有图片';
		grid.append(empty);
		return;
	}

	for (const asset of assets) {
		const button = document.createElement('button');
		button.type = 'button';
		button.className = 'asset';
		button.dataset.path = asset.path;
		button.dataset.active = String(state.hero === asset.path);
		button.title = `${asset.path}（${Math.max(1, Math.round(asset.size / 1024))} KB）`;

		const img = document.createElement('img');
		img.src = `/asset?path=${encodeURIComponent(asset.path)}`;
		img.loading = 'lazy';
		img.alt = asset.name;

		const name = document.createElement('span');
		name.textContent = asset.name;

		button.append(img, name);
		button.addEventListener('click', () => setHero(asset.path));
		grid.append(button);
	}
}

function renderAssetsActive() {
	for (const node of document.querySelectorAll('.asset')) {
		node.dataset.active = String(node.dataset.path === state.hero);
	}
}

function setHero(path) {
	state.hero = path;
	updateCover();
	renderAssetsActive();
	markDirty();
	toast(path ? `封面：${path}` : '已清除封面');
}

async function uploadAsset(file) {
	if (!file) return;
	try {
		toast(`上传中：${file.name}`);
		const { asset } = await api(`/api/asset?name=${encodeURIComponent(file.name)}`, {
			method: 'POST',
			body: file,
		});
		await refreshAssets();
		setHero(asset.path);
		toast(`已上传并设为封面：${asset.path}`);
	} catch (error) {
		toast(error.message, 'error');
	}
}

/* ---------------- 预览与 dev server ---------------- */

function previewBaseUrl() {
	return (state.dev.url || state.meta?.devUrl || 'http://127.0.0.1:4321').replace(/\/$/, '');
}

function refreshPreview() {
	const frame = el('preview-frame');
	const note = el('preview-note');
	const current = state.current;

	if (!current?.exists) {
		frame.src = 'about:blank';
		note.textContent = '保存后才能预览';
		return;
	}
	if (!state.dev.running) {
		frame.src = 'about:blank';
		note.textContent = '预览服务未启动';
		return;
	}

	note.textContent = '';
	frame.src = `${previewBaseUrl()}/blog/${encodeURIComponent(current.slug)}/?t=${Date.now()}`;
}

async function refreshDev() {
	try {
		const status = await getJSON('/api/dev/status');
		const wasRunning = state.dev.running;
		state.dev = { running: status.running, url: status.url };
		el('dev-dot').dataset.state = status.running ? 'up' : 'down';
		el('dev-label').textContent = status.running ? `预览服务 ${status.url}` : '预览服务未启动';
		el('btn-dev').textContent = status.running ? '停止' : '启动';
		if (status.running !== wasRunning) refreshPreview();
	} catch {
		el('dev-dot').dataset.state = 'down';
		el('dev-label').textContent = '控制台服务异常';
	}
}

async function toggleDev() {
	const button = el('btn-dev');
	const wasRunning = state.dev.running;
	button.disabled = true;
	button.textContent = wasRunning ? '停止中…' : '启动中…';
	try {
		const result = await postJSON(wasRunning ? '/api/dev/stop' : '/api/dev/start');
		const tail = String(result.output ?? '').trim().split('\n').filter(Boolean).slice(-2).join(' ');
		toast(result.ok ? tail || '已完成' : result.output || '操作失败', result.ok ? 'info' : 'error');
	} catch (error) {
		toast(error.message, 'error');
	} finally {
		button.disabled = false;
		await refreshDev();
	}
}

async function showDevLogs() {
	switchTab('publish');
	const log = el('build-log');
	log.hidden = false;
	log.textContent = '';
	try {
		const { output } = await getJSON('/api/dev/logs');
		appendLog(log, output?.trim() || '(没有日志)');
	} catch (error) {
		appendLog(log, `✗ ${error.message}`);
	}
}

/* ---------------- 构建与发布 ---------------- */

async function runBuild() {
	const button = el('btn-build');
	const log = el('build-log');
	switchTab('publish');
	log.hidden = false;
	log.textContent = '';
	button.disabled = true;
	button.textContent = '构建中…';

	try {
		const code = await streamPost('/api/build', {}, {
			step: ({ label }) => appendLog(log, `▶ ${label}`),
			line: (line) => appendLog(log, line),
			exit: ({ code: exitCode, failed }) =>
				appendLog(
					log,
					exitCode === 0 ? '\n✓ 构建完成，搜索索引已重建' : `\n✗ 构建失败：${failed ?? ''}（退出码 ${exitCode}）`,
				),
		});
		toast(code === 0 ? '构建完成' : `构建失败（退出码 ${code}）`, code === 0 ? 'info' : 'error');
	} catch (error) {
		appendLog(log, `✗ ${error.message}`);
		toast(error.message, 'error');
	} finally {
		button.disabled = false;
		button.textContent = '构建并重建搜索索引';
	}
}

function suggestMessage(status) {
	if (!status.files?.length) return '';
	const postFile = status.files.find((file) => file.file.includes('src/content/blog/'));
	if (status.files.length === 1 && postFile) {
		const name = postFile.file.split('/').pop()?.replace(/\.mdx?$/, '') ?? '';
		return `post: 更新 ${name}`;
	}
	return `post: 更新文章与站点内容（${status.files.length} 个文件）`;
}

async function refreshGit() {
	const branch = el('git-branch');
	const box = el('git-files');
	try {
		const status = await getJSON('/api/git/status');
		if (!status.isRepo) {
			branch.textContent = status.error ?? '当前目录不是 git 仓库';
			box.replaceChildren();
			return;
		}

		const parts = [status.branch ?? '未知分支'];
		if (status.ahead) parts.push(`领先 ${status.ahead}`);
		if (status.behind) parts.push(`落后 ${status.behind}`);
		if (status.lastCommit) parts.push(`最近提交 ${status.lastCommit}`);
		branch.textContent = parts.join(' · ');

		box.replaceChildren();
		if (!status.files.length) {
			const row = document.createElement('div');
			row.className = 'git-file';
			row.textContent = '工作区干净，没有待提交的改动';
			box.append(row);
		}
		for (const file of status.files) {
			const row = document.createElement('div');
			row.className = 'git-file';
			const code = document.createElement('span');
			code.className = 'code';
			code.textContent = file.code;
			const text = document.createElement('span');
			text.className = 'path';
			text.textContent = file.file;
			row.append(code, text);
			box.append(row);
		}

		const input = el('git-message');
		if (!input.value.trim()) input.value = suggestMessage(status);
	} catch (error) {
		branch.textContent = error.message;
	}
}

async function publish() {
	const log = el('publish-log');
	const message = el('git-message').value.trim();

	try {
		const status = await getJSON('/api/git/status');
		if (!status.isRepo) throw new Error(status.error ?? '当前目录不是 git 仓库');
		if (status.files?.length && !message) {
			toast('请先填写提交信息', 'error');
			el('git-message').focus();
			return;
		}

		const summary = status.files?.length ? `${status.files.length} 个文件的改动将提交并推送` : '没有待提交的改动，只执行 git push';
		if (!window.confirm(`${summary}。\n\n继续？`)) return;

		log.hidden = false;
		log.textContent = '';
		const button = el('btn-publish');
		button.disabled = true;
		button.textContent = '推送中…';

		const code = await streamPost('/api/git/publish', { message }, {
			step: ({ label }) => appendLog(log, `▶ ${label}`),
			line: (line) => appendLog(log, line),
			exit: ({ code: exitCode, failed }) =>
				appendLog(log, exitCode === 0 ? '\n✓ 已推送' : `\n✗ 失败：${failed ?? ''}（退出码 ${exitCode}）`),
		});

		toast(code === 0 ? '已推送到 GitHub' : `推送失败（退出码 ${code}）`, code === 0 ? 'info' : 'error');
	} catch (error) {
		toast(error.message, 'error');
		log.hidden = false;
		appendLog(log, `✗ ${error.message}`);
	} finally {
		const button = el('btn-publish');
		button.disabled = false;
		button.textContent = '提交并推送';
		await refreshGit();
	}
}

/* ---------------- 编辑区小工具 ---------------- */

function applyPrefix(prefix) {
	const textarea = el('f-body');
	const value = textarea.value;
	const start = value.lastIndexOf('\n', textarea.selectionStart - 1) + 1;
	let end = textarea.selectionEnd;
	if (end > start && value[end - 1] === '\n') end -= 1;

	const block = value.slice(start, end);
	const next = block
		.split('\n')
		.map((line) => (line.trim() === '' ? line : prefix + line))
		.join('\n');

	textarea.value = value.slice(0, start) + next + value.slice(end);
	textarea.focus();
	textarea.setSelectionRange(start, start + next.length);
	markDirty();
	updateBodyStats();
}

function wrapSelection(before, after = before) {
	const textarea = el('f-body');
	const { selectionStart: start, selectionEnd: end, value } = textarea;
	const selected = value.slice(start, end);
	textarea.value = value.slice(0, start) + before + selected + after + value.slice(end);
	textarea.focus();
	textarea.setSelectionRange(start + before.length, start + before.length + selected.length);
	markDirty();
	updateBodyStats();
}

function insertLink() {
	const textarea = el('f-body');
	const { selectionStart: start, selectionEnd: end, value } = textarea;
	const selected = value.slice(start, end) || '链接文字';
	const snippet = `[${selected}](https://)`;
	textarea.value = value.slice(0, start) + snippet + value.slice(end);
	textarea.focus();
	const cursor = start + snippet.length - 1;
	textarea.setSelectionRange(cursor, cursor);
	markDirty();
	updateBodyStats();
}

function insertAtCursor(text) {
	const textarea = el('f-body');
	const { selectionStart: start, selectionEnd: end, value } = textarea;
	textarea.value = value.slice(0, start) + text + value.slice(end);
	textarea.focus();
	textarea.setSelectionRange(start + text.length, start + text.length);
	markDirty();
	updateBodyStats();
}

function insertCodeBlock() {
	const textarea = el('f-body');
	const { selectionStart: start, selectionEnd: end, value } = textarea;
	const selected = value.slice(start, end);
	const snippet = `\`\`\`\n${selected}\n\`\`\``;
	textarea.value = value.slice(0, start) + snippet + value.slice(end);
	textarea.focus();
	textarea.setSelectionRange(start + 3, start + 3 + selected.length);
	markDirty();
	updateBodyStats();
}

/* ---------------- 标签页与事件 ---------------- */

function switchTab(name) {
	for (const tab of document.querySelectorAll('.tab')) {
		tab.classList.toggle('active', tab.dataset.tab === name);
	}
	for (const panel of document.querySelectorAll('.panel')) {
		panel.hidden = panel.id !== `panel-${name}`;
	}
}

function bindEvents() {
	el('btn-save').addEventListener('click', () => savePost());
	el('btn-new').addEventListener('click', newPost);
	el('btn-delete').addEventListener('click', deletePost);
	el('btn-refresh-preview').addEventListener('click', refreshPreview);
	el('btn-dev').addEventListener('click', toggleDev);
	el('btn-dev-logs').addEventListener('click', showDevLogs);
	el('btn-refresh-assets').addEventListener('click', refreshAssets);
	el('btn-clear-cover').addEventListener('click', () => setHero(null));
	el('btn-build').addEventListener('click', runBuild);
	el('btn-git-refresh').addEventListener('click', refreshGit);
	el('btn-publish').addEventListener('click', publish);

	el('asset-upload').addEventListener('change', async (event) => {
		const file = event.target.files?.[0];
		event.target.value = '';
		if (file) await uploadAsset(file);
	});

	el('search').addEventListener('input', (event) => {
		state.search = event.target.value;
		renderList();
	});

	for (const tab of document.querySelectorAll('.tab')) {
		tab.addEventListener('click', () => switchTab(tab.dataset.tab));
	}

	// 标题 → 自动生成 slug（已有文章和手动改过 slug 的不动）
	el('f-title').addEventListener('input', () => {
		if (!state.slugTouched) el('f-slug').value = slugify(el('f-title').value);
		markDirty();
	});
	el('f-slug').addEventListener('input', () => {
		state.slugTouched = true;
		markDirty();
	});

	for (const id of ['f-desc', 'f-date', 'f-updated', 'f-tags', 'f-draft', 'f-mdx']) {
		el(id).addEventListener('input', markDirty);
		el(id).addEventListener('change', markDirty);
	}

	el('f-body').addEventListener('input', () => {
		markDirty();
		updateBodyStats();
	});

	for (const button of document.querySelectorAll('.editor-toolbar .btn')) {
		button.addEventListener('click', () => {
			if (button.dataset.block) applyPrefix(button.dataset.wrap);
			else if (button.dataset.wrap) wrapSelection(button.dataset.wrap);
			else if (button.dataset.link) insertLink();
			else if (button.dataset.code) insertCodeBlock();
			else if (button.dataset.rule) insertAtCursor('\n\n---\n\n');
		});
	}

	document.addEventListener('keydown', (event) => {
		if (!(event.ctrlKey || event.metaKey)) return;
		if (event.key.toLowerCase() === 's') {
			event.preventDefault();
			savePost();
		}
	});

	window.addEventListener('beforeunload', (event) => {
		if (!state.dirty) return;
		// 现代浏览器用 preventDefault 就能弹确认框（returnValue 已废弃）
		event.preventDefault();
	});
}

async function boot() {
	try {
		state.meta = await getJSON('/api/meta');
		el('root-path').textContent = state.meta.root;
	} catch (error) {
		toast(`连不上控制台服务：${error.message}`, 'error');
		return;
	}

	bindEvents();
	setDirty(false);

	try {
		await refreshPosts();
	} catch (error) {
		toast(`读取文章列表失败：${error.message}`, 'error');
	}

	await Promise.all([refreshDev(), refreshAssets(), refreshGit()]);
	setInterval(refreshDev, 5000);

	if (!state.posts.length) newPost();
}

boot();
