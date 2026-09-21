#!/usr/bin/env node
/**
 * 文章控制台 —— 本机 GUI，用来写文章、管封面图、跑构建、提交推送。
 *
 *   pnpm admin        → http://127.0.0.1:8361
 *
 * 设计约束：
 *   1. 只监听 127.0.0.1，并校验 Origin/Host，避免其它网页隔空调用本机接口
 *   2. 前端放在 server/admin/（不是 public/），不会被 Astro 构建进 dist/，生产站点零改动
 *   3. 写操作全部限制在 src/content/blog/ 与 src/assets/ 内
 */
import { spawn as nodeSpawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
	DEFAULT_BODY,
	assetAbsolutePath,
	defaultRoots,
	deletePost,
	findPostFile,
	httpError,
	listAssets,
	listPosts,
	readPost,
	saveAsset,
	savePost,
} from './frontmatter.js';

export const ADMIN_DIR = fileURLToPath(new URL('./admin/', import.meta.url));
export const DEFAULT_PORT = Number(process.env.ADMIN_PORT || 8361);
export const DEFAULT_DEV_URL = process.env.ADMIN_DEV_URL || 'http://localhost:4321';

const PACKAGE_BIN = 'pnpm';
const MAX_JSON_BODY = 4 * 1024 * 1024;
const MAX_UPLOAD_BODY = 24 * 1024 * 1024;

/**
 * Node 20+ 在 Windows 上禁止直接 spawn 一个 .cmd（pnpm/npm 都是 .cmd 垫片），会抛 EINVAL。
 * 所以固定命令在 Windows 上统一经 cmd.exe 走一遍；这些参数里没有用户输入，不存在转义问题
 * （用户输入只出现在 git 提交信息里，那条是直接 spawn git 的）。
 */
function pmCommand(args) {
	if (process.platform !== 'win32') return { command: PACKAGE_BIN, args };
	const line = [PACKAGE_BIN, ...args].join(' ');
	return { command: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', line] };
}

const MIME_TYPES = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.webp': 'image/webp',
	'.avif': 'image/avif',
	'.gif': 'image/gif',
	'.svg': 'image/svg+xml',
	'.ico': 'image/x-icon',
};

const STATIC_ROUTES = {
	'/': 'index.html',
	'/index.html': 'index.html',
	'/app.js': 'app.js',
	'/styles.css': 'styles.css',
};

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

function stripAnsi(text) {
	// eslint-disable-next-line no-control-regex
	return String(text).replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');
}

function json(res, status, payload) {
	const body = JSON.stringify(payload);
	res.writeHead(status, {
		'Content-Type': 'application/json; charset=utf-8',
		'Content-Length': Buffer.byteLength(body),
		'Cache-Control': 'no-store',
	});
	res.end(body);
}

function readBody(req, limit) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		req.on('data', (chunk) => {
			size += chunk.length;
			if (size > limit) {
				reject(httpError(413, '请求体太大'));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on('end', () => resolve(Buffer.concat(chunks)));
		req.on('error', reject);
	});
}

async function readJson(req) {
	const raw = await readBody(req, MAX_JSON_BODY);
	if (!raw.length) return {};
	try {
		return JSON.parse(raw.toString('utf8'));
	} catch {
		throw httpError(400, '请求体不是合法 JSON');
	}
}

/** 极简 git status --porcelain=v1 --branch 解析 */
export function parseGitStatus(output) {
	const lines = String(output ?? '').split(/\r?\n/).filter((line) => line.trim() !== '');
	const header = lines.shift() ?? '';
	const headerMatch = /^##\s+([^\s.]+)(?:\.\.\.(\S+))?(?:\s+\[(.+)\])?/.exec(header);
	const aheadMatch = /ahead (\d+)/.exec(headerMatch?.[3] ?? '');
	const behindMatch = /behind (\d+)/.exec(headerMatch?.[3] ?? '');

	const files = lines
		.map((line) => ({ code: line.slice(0, 2).trim() || '?', file: line.slice(3).trim() }))
		.filter((entry) => entry.file);

	return {
		isRepo: Boolean(headerMatch),
		branch: headerMatch?.[1] ?? null,
		upstream: headerMatch?.[2] ?? null,
		ahead: aheadMatch ? Number(aheadMatch[1]) : 0,
		behind: behindMatch ? Number(behindMatch[1]) : 0,
		files,
	};
}

/* ------------------------------------------------------------------ *
 * 服务
 * ------------------------------------------------------------------ */

export function createAdminServer({
	root = process.env.ADMIN_ROOT || path.resolve(fileURLToPath(new URL('..', import.meta.url))),
	spawn = nodeSpawn,
	devUrl = DEFAULT_DEV_URL,
} = {}) {
	const roots = defaultRoots(root);
	let devStatusCache = { at: 0, value: null };

	/** 请求头校验：只服务本机页面，挡掉其它站点的隔空调用 */
	function guard(req) {
		const host = req.headers.host ?? '';
		if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(host)) {
			throw httpError(403, '只接受本机请求');
		}
		const origin = req.headers.origin;
		if (origin && origin !== `http://${host}`) {
			throw httpError(403, '拒绝跨站请求');
		}
	}

	/** 跑一条命令，逐行回调；返回退出码 */
	function runStep({ command, args, cwd = roots.root, env, onLine }) {
		return new Promise((resolve) => {
			let child;
			try {
				child = spawn(command, args, {
					cwd,
					env: { ...process.env, ...env },
					windowsHide: true,
				});
			} catch (error) {
				onLine(`启动失败：${error.message}`);
				resolve(-1);
				return;
			}

			const pipe = (stream) => {
				if (!stream) return;
				let buffer = '';
				stream.on('data', (chunk) => {
					buffer += String(chunk);
					const lines = buffer.split(/\r?\n/);
					buffer = lines.pop() ?? '';
					for (const line of lines) onLine(stripAnsi(line));
				});
				stream.on('end', () => {
					if (buffer.trim()) onLine(stripAnsi(buffer));
				});
			};
			pipe(child.stdout);
			pipe(child.stderr);

			child.on('error', (error) => {
				onLine(`启动失败：${error.message}`);
				resolve(-1);
			});
			child.on('close', (code) => resolve(code ?? -1));
		});
	}

	async function capture(spec, options = {}) {
		const lines = [];
		const code = await runStep({ ...spec, ...options, onLine: (line) => lines.push(line) });
		return { code, output: lines.join('\n') };
	}

	function sse(res) {
		res.writeHead(200, {
			'Content-Type': 'text/event-stream; charset=utf-8',
			'Cache-Control': 'no-cache, no-transform',
			Connection: 'keep-alive',
			'X-Accel-Buffering': 'no',
		});
		let closed = false;
		res.on('close', () => {
			closed = true;
		});
		return {
			send(event, data) {
				if (closed || res.writableEnded) return;
				res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
			},
			end() {
				if (!res.writableEnded) res.end();
			},
		};
	}

	/** 依次执行多条命令，通过 SSE 实时回传 */
	async function streamSteps(res, steps) {
		const channel = sse(res);
		for (const [index, step] of steps.entries()) {
			channel.send('step', { index, total: steps.length, label: step.label });
			const code = await runStep({ ...step, onLine: (line) => channel.send('line', line) });
			if (code !== 0) {
				channel.send('exit', { code, failed: step.label });
				channel.end();
				return;
			}
		}
		channel.send('exit', { code: 0 });
		channel.end();
	}

	async function probeDev() {
		try {
			const response = await fetch(devUrl, { signal: AbortSignal.timeout(800) });
			return { ok: true, status: response.status };
		} catch (error) {
			return { ok: false, error: error.name === 'TimeoutError' ? '连接超时' : error.message };
		}
	}

	/** astro dev status 的输出缓存 4 秒，避免轮询时反复起进程 */
	async function devCliStatus() {
		if (Date.now() - devStatusCache.at < 4000) return devStatusCache.value;
		const { code, output } = await capture(pmCommand(['astro', 'dev', 'status']));
		const url = /https?:\/\/[^\s'"]+/.exec(output)?.[0] ?? null;
		const value = { code, output, url };
		devStatusCache = { at: Date.now(), value };
		return value;
	}

	async function gitStatus() {
		const { code, output } = await capture({ command: 'git', args: ['status', '--porcelain=v1', '--branch'] });
		if (code !== 0) {
			return { isRepo: false, error: output.trim() || 'git status 执行失败', files: [] };
		}
		const status = parseGitStatus(output);
		const last = await capture({ command: 'git', args: ['log', '-1', '--format=%h %s'] });
		return { ...status, lastCommit: last.code === 0 ? last.output.trim() : null };
	}

	async function handle(req, res) {
		const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
		const route = url.pathname;

		// 静态前端
		if (req.method === 'GET' && STATIC_ROUTES[route]) {
			guard(req);
			const file = path.join(ADMIN_DIR, STATIC_ROUTES[route]);
			const data = await readFile(file);
			res.writeHead(200, {
				'Content-Type': MIME_TYPES[path.extname(file)] ?? 'application/octet-stream',
				'Content-Length': data.length,
				'Cache-Control': 'no-store',
			});
			res.end(data);
			return;
		}

		guard(req);

		// 封面图缩略图
		if (req.method === 'GET' && route === '/asset') {
			const target = assetAbsolutePath(url.searchParams.get('path'), roots);
			const data = await readFile(target);
			res.writeHead(200, {
				'Content-Type': MIME_TYPES[path.extname(target).toLowerCase()] ?? 'application/octet-stream',
				'Content-Length': data.length,
				'Cache-Control': 'no-store',
			});
			res.end(data);
			return;
		}

		/* ---------------- 接口 ---------------- */

		if (req.method === 'GET' && route === '/api/meta') {
			json(res, 200, {
				root: roots.root,
				blogDir: roots.blogDir,
				assetsDir: roots.assetsDir,
				devUrl: (await devCliStatus()).url ?? devUrl,
				defaultBody: DEFAULT_BODY,
			});
			return;
		}

		if (req.method === 'GET' && route === '/api/posts') {
			json(res, 200, { posts: await listPosts(roots) });
			return;
		}

		if (req.method === 'GET' && route === '/api/post') {
			const slug = url.searchParams.get('slug');
			if (!slug) throw httpError(400, '缺少 slug');
			json(res, 200, { post: await readPost(slug, roots) });
			return;
		}

		if (req.method === 'POST' && route === '/api/post') {
			const payload = await readJson(req);
			const existed = payload.originalSlug ? findPostFile(String(payload.originalSlug), roots) : null;
			const post = await savePost(payload, roots);
			json(res, existed ? 200 : 201, { post });
			return;
		}

		if (req.method === 'POST' && route === '/api/post/delete') {
			const payload = await readJson(req);
			if (!payload.slug) throw httpError(400, '缺少 slug');
			json(res, 200, { deleted: await deletePost(String(payload.slug), roots) });
			return;
		}

		if (req.method === 'GET' && route === '/api/assets') {
			json(res, 200, { assets: await listAssets(roots) });
			return;
		}

		if (req.method === 'POST' && route === '/api/asset') {
			const name = url.searchParams.get('name') ?? 'image';
			const buffer = await readBody(req, MAX_UPLOAD_BODY);
			json(res, 201, { asset: await saveAsset(name, buffer, roots) });
			return;
		}

		if (req.method === 'GET' && route === '/api/dev/status') {
			const [probe, cli] = await Promise.all([probeDev(), devCliStatus()]);
			json(res, 200, {
				running: probe.ok || Boolean(cli.url),
				url: cli.url ?? devUrl,
				http: probe,
				detail: cli.output,
			});
			return;
		}

		if (req.method === 'POST' && route === '/api/dev/start') {
			const result = await capture(pmCommand(['astro', 'dev', '--background']));
			devStatusCache = { at: 0, value: null };
			const cli = await devCliStatus();
			// 失败也回 200：让前端拿到完整输出，而不是一句 Internal Server Error
			json(res, 200, { ok: result.code === 0, output: result.output, url: cli.url ?? devUrl });
			return;
		}

		if (req.method === 'POST' && route === '/api/dev/stop') {
			const result = await capture(pmCommand(['astro', 'dev', 'stop']));
			devStatusCache = { at: 0, value: null };
			json(res, 200, { ok: result.code === 0, output: result.output });
			return;
		}

		if (req.method === 'GET' && route === '/api/dev/logs') {
			const result = await capture(pmCommand(['astro', 'dev', 'logs']));
			json(res, 200, { output: result.output });
			return;
		}

		if (req.method === 'POST' && route === '/api/build') {
			await streamSteps(res, [
				{ label: 'pnpm build（astro build + pagefind）', ...pmCommand(['run', 'build']) },
			]);
			return;
		}

		if (req.method === 'GET' && route === '/api/git/status') {
			json(res, 200, await gitStatus());
			return;
		}

		if (req.method === 'POST' && route === '/api/git/publish') {
			const payload = await readJson(req);
			const message = String(payload.message ?? '').trim();
			const status = await gitStatus();
			if (!status.isRepo) throw httpError(400, status.error ?? '当前目录不是 git 仓库');

			const steps = [];
			if (status.files.length) {
				if (!message) throw httpError(400, '请先填写提交信息');
				steps.push({ label: 'git add -A', command: 'git', args: ['add', '-A'] });
				steps.push({
					label: `git commit -m ${JSON.stringify(message)}`,
					command: 'git',
					args: ['commit', '-m', message],
				});
			}

			// 新分支还没有 upstream，第一次得带 -u，否则 git push 直接报错退出
			if (!status.upstream && status.branch) {
				steps.push({
					label: `git push -u origin ${status.branch}`,
					command: 'git',
					args: ['push', '-u', 'origin', status.branch],
				});
			} else {
				steps.push({ label: 'git push', command: 'git', args: ['push'] });
			}

			const env = { GIT_TERMINAL_PROMPT: '0' };
			await streamSteps(
				res,
				steps.map((step) => ({ ...step, env })),
			);
			return;
		}

		json(res, 404, { error: `未知接口：${req.method} ${route}` });
	}

	const server = createServer((req, res) => {
		handle(req, res).catch((error) => {
			const status = error.status ?? 500;
			if (res.headersSent) {
				res.end();
				return;
			}
			if (status >= 500) console.error('[admin]', error);
			json(res, status, { error: error.message });
		});
	});

	return { server, roots };
}

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */

const isDirectRun =
	Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
	const { server, roots } = createAdminServer({});
	server.on('error', (error) => {
		if (error.code === 'EADDRINUSE') {
			console.error(`\n端口 ${DEFAULT_PORT} 已被占用。换个端口：ADMIN_PORT=8362 pnpm admin`);
			process.exitCode = 1;
			return;
		}
		throw error;
	});
	server.listen(DEFAULT_PORT, '127.0.0.1', () => {
		console.log(`\n文章控制台：http://127.0.0.1:${DEFAULT_PORT}`);
		console.log(`项目目录：${roots.root}`);
		console.log(`文章目录：${roots.blogDir}`);
		console.log('\nCtrl+C 退出（预览用的 astro dev 用控制台里的按钮启停）\n');
	});
}
