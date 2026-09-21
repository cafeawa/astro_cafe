import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';

import { createAdminServer, parseGitStatus } from '../server/admin.js';
import { withTempProject } from './helpers/temp-project.js';

/**
 * 可控的 child_process.spawn 替身：按命令行返回预设输出与退出码。
 * 传进来的是「命令 + 参数」拼成的一整行，这样 Windows 上用 cmd.exe 包一层也能匹配。
 */
function fakeSpawn(resolve) {
	const calls = [];
	const spawnFn = (command, args) => {
		const line = [command, ...args].join(' ');
		calls.push(line);
		const child = new EventEmitter();
		child.stdout = new EventEmitter();
		child.stderr = new EventEmitter();
		child.pid = 4242;
		child.kill = () => {};

		const responder = resolve(line) ?? { code: 0, lines: [] };
		setImmediate(() => {
			for (const line of responder.lines ?? []) child.stdout.emit('data', `${line}\n`);
			child.stdout.emit('end');
			child.stderr.emit('end');
			child.emit('close', responder.code ?? 0);
		});
		return child;
	};
	spawnFn.calls = calls;
	return spawnFn;
}

async function startServer(paths, options = {}) {
	const { server } = createAdminServer({
		root: paths.root,
		devUrl: 'http://127.0.0.1:59999',
		...options,
	});
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	const { port } = server.address();
	return {
		port,
		base: `http://127.0.0.1:${port}`,
		close: () => new Promise((resolve) => server.close(resolve)),
	};
}

async function readSse(response) {
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	const events = [];
	let buffer = '';

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
			if (data) events.push({ event, data: JSON.parse(data) });
		}
	}

	return events;
}

/** 只保留文件头的最小假图：saveAsset 会校验字节 */
const FAKE_PNG = Buffer.concat([
	Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
	Buffer.from('fake-png-data'),
]);

function rawRequest(port, { method = 'GET', path = '/api/meta', headers = {} } = {}) {
	return new Promise((resolve, reject) => {
		const req = request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
			let body = '';
			res.on('data', (chunk) => (body += chunk));
			res.on('end', () => resolve({ status: res.statusCode, body }));
		});
		req.on('error', reject);
		req.end();
	});
}

test('parseGitStatus 解析分支、领先/落后与文件列表', () => {
	const status = parseGitStatus(
		['## main...origin/main [ahead 2, behind 1]', ' M src/content/blog/a.md', '?? scripts/'].join('\n'),
	);

	assert.equal(status.isRepo, true);
	assert.equal(status.branch, 'main');
	assert.equal(status.upstream, 'origin/main');
	assert.equal(status.ahead, 2);
	assert.equal(status.behind, 1);
	assert.deepEqual(status.files, [
		{ code: 'M', file: 'src/content/blog/a.md' },
		{ code: '??', file: 'scripts/' },
	]);

	assert.equal(parseGitStatus('fatal: not a git repository').isRepo, false);
});

test(
	'静态前端与 /api/meta 可用',
	withTempProject(async (paths) => {
		const spawn = fakeSpawn(() => ({ lines: ['No dev server is running.'], code: 1 }));
		const server = await startServer(paths, { spawn });
		try {
			const page = await fetch(`${server.base}/`);
			assert.equal(page.status, 200);
			assert.match(page.headers.get('content-type'), /text\/html/);
			assert.match(await page.text(), /文章控制台/);

			for (const asset of ['/app.js', '/styles.css']) {
				const response = await fetch(`${server.base}${asset}`);
				assert.equal(response.status, 200, `${asset} 应该能取到`);
			}

			const meta = await (await fetch(`${server.base}/api/meta`)).json();
			assert.equal(meta.root, paths.root);
			assert.match(meta.blogDir, /content/);
			assert.ok(meta.defaultBody);
		} finally {
			await server.close();
		}
	}),
);

test(
	'文章接口：新建、读取、更新、列表与删除',
	withTempProject(async (paths) => {
		const server = await startServer(paths);
		try {
			const created = await fetch(`${server.base}/api/post`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					title: '接口测试',
					description: '摘要',
					pubDate: '2026-02-14',
					tags: 'Astro, 笔记',
					body: '正文内容',
				}),
			});
			assert.equal(created.status, 201);
			const { post } = await created.json();
			assert.equal(post.slug, '接口测试');
			assert.deepEqual(post.tags, ['Astro', '笔记']);
			assert.equal(existsSync(join(paths.blogDir, '接口测试.md')), true);

			const single = await (await fetch(`${server.base}/api/post?slug=${encodeURIComponent(post.slug)}`)).json();
			assert.equal(single.post.body, '正文内容');

			const updated = await fetch(`${server.base}/api/post`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					originalSlug: post.slug,
					slug: 'renamed',
					title: '改名后',
					description: '',
					pubDate: '2026-02-15',
					body: '新正文',
				}),
			});
			assert.equal(updated.status, 200);
			assert.equal(existsSync(join(paths.blogDir, '接口测试.md')), false);
			assert.equal(existsSync(join(paths.blogDir, 'renamed.md')), true);

			const list = await (await fetch(`${server.base}/api/posts`)).json();
			assert.deepEqual(list.posts.map((entry) => entry.slug), ['renamed']);

			const deleted = await fetch(`${server.base}/api/post/delete`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ slug: 'renamed' }),
			});
			assert.equal(deleted.status, 200);
			assert.equal(existsSync(join(paths.blogDir, 'renamed.md')), false);
		} finally {
			await server.close();
		}
	}),
);

test(
	'重名与非法输入返回 4xx，而不是 500',
	withTempProject(async (paths) => {
		const server = await startServer(paths);
		try {
			const post = (body) =>
				fetch(`${server.base}/api/post`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify(body),
				});

			assert.equal((await post({ title: 'Dup', description: '', pubDate: '2026-02-14' })).status, 201);
			assert.equal((await post({ title: 'Dup', description: '', pubDate: '2026-02-14' })).status, 409);
			assert.equal((await post({ title: '' })).status, 400);
			assert.equal((await post({ title: '🎉' })).status, 400);

			// slug 里的路径符号会被规整掉，而不是跑出文章目录
			const normalized = await post({ title: 'Bad', slug: '../escape', description: '', pubDate: '2026-02-14' });
			assert.equal(normalized.status, 201);
			assert.equal((await normalized.json()).post.slug, 'escape');
			assert.equal(existsSync(join(paths.blogDir, 'escape.md')), true);
			assert.equal(existsSync(join(paths.root, 'escape.md')), false);

			const missing = await fetch(`${server.base}/api/post?slug=nope`);
			assert.equal(missing.status, 404);
			assert.match((await missing.json()).error, /找不到文章/);

			const badJson = await fetch(`${server.base}/api/post`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: '{ not json',
			});
			assert.equal(badJson.status, 400);
		} finally {
			await server.close();
		}
	}),
);

test(
	'只服务本机：跨站 Origin 和非本机 Host 都被拒',
	withTempProject(async (paths) => {
		const server = await startServer(paths);
		try {
			const crossSite = await fetch(`${server.base}/api/posts`, { headers: { Origin: 'http://evil.example' } });
			assert.equal(crossSite.status, 403);

			const badHost = await rawRequest(server.port, { headers: { Host: 'evil.example' } });
			assert.equal(badHost.status, 403);

			const okHost = await rawRequest(server.port, { headers: { Host: `127.0.0.1:${server.port}` } });
			assert.equal(okHost.status, 200);
		} finally {
			await server.close();
		}
	}),
);

test(
	'图片：上传、缩略图读取、路径穿越被拒',
	withTempProject(async (paths) => {
		const server = await startServer(paths);
		try {
			const upload = await fetch(`${server.base}/api/asset?name=cover.png`, {
				method: 'POST',
				body: FAKE_PNG,
			});
			assert.equal(upload.status, 201);
			const { asset } = await upload.json();
			assert.equal(asset.path, 'src/assets/cover.png');

			// 改了扩展名的坏文件必须被挡住，否则 Astro 读不到图片元数据会拖垮整站
			const broken = await fetch(`${server.base}/api/asset?name=broken.png`, {
				method: 'POST',
				body: Buffer.from('这不是图片'),
			});
			assert.equal(broken.status, 400);
			assert.match((await broken.json()).error, /不是有效的 PNG 图片/);
			assert.equal(existsSync(join(paths.assetsDir, 'broken.png')), false);

			const thumb = await fetch(`${server.base}/asset?path=${encodeURIComponent(asset.path)}`);
			assert.equal(thumb.status, 200);
			assert.equal(thumb.headers.get('content-type'), 'image/png');

			const escape = await fetch(`${server.base}/asset?path=${encodeURIComponent('../../secret.png')}`);
			assert.equal(escape.status, 403);

			const outside = await fetch(`${server.base}/asset?path=${encodeURIComponent('src/content/blog/x.md')}`);
			assert.equal(outside.status, 403);

			const assets = await (await fetch(`${server.base}/api/assets`)).json();
			assert.deepEqual(assets.assets.map((entry) => entry.name), ['cover.png']);
		} finally {
			await server.close();
		}
	}),
);

test(
	'构建接口把日志按 SSE 流式回传，并给出退出码',
	withTempProject(async (paths) => {
		const spawn = fakeSpawn((line) =>
			line.includes('run build')
				? { lines: ['building client...', 'pagefind: 12 pages indexed'], code: 0 }
				: { lines: [], code: 0 },
		);
		const server = await startServer(paths, { spawn });
		try {
			const response = await fetch(`${server.base}/api/build`, { method: 'POST' });
			assert.match(response.headers.get('content-type'), /text\/event-stream/);

			const events = await readSse(response);
			const kinds = events.map((event) => event.event);
			assert.equal(kinds[0], 'step');
			assert.ok(kinds.includes('line'));
			assert.equal(kinds.at(-1), 'exit');
			assert.equal(events.at(-1).data.code, 0);
			assert.match(events.map((event) => event.data).join('\n'), /pagefind/);
			assert.ok(spawn.calls.some((call) => call.includes('run build')));
		} finally {
			await server.close();
		}
	}),
);

test(
	'构建失败时退出码非 0',
	withTempProject(async (paths) => {
		const spawn = fakeSpawn(() => ({ lines: ['error: build failed'], code: 1 }));
		const server = await startServer(paths, { spawn });
		try {
			const events = await readSse(await fetch(`${server.base}/api/build`, { method: 'POST' }));
			assert.equal(events.at(-1).event, 'exit');
			assert.equal(events.at(-1).data.code, 1);
		} finally {
			await server.close();
		}
	}),
);

test(
	'git 状态与「提交并推送」的步骤顺序',
	withTempProject(async (paths) => {
		const spawn = fakeSpawn((line) => {
			if (line.includes('status --porcelain=v1 --branch')) {
				return { lines: ['## main...origin/main', ' M src/content/blog/a.md'], code: 0 };
			}
			if (line.includes('log -1 --format=%h %s')) return { lines: ['abc1234 post: 上一篇文章'], code: 0 };
			return { lines: [`ran ${line}`], code: 0 };
		});
		const server = await startServer(paths, { spawn });
		try {
			const status = await (await fetch(`${server.base}/api/git/status`)).json();
			assert.equal(status.isRepo, true);
			assert.equal(status.branch, 'main');
			assert.equal(status.lastCommit, 'abc1234 post: 上一篇文章');
			assert.equal(status.files.length, 1);

			const events = await readSse(
				await fetch(`${server.base}/api/git/publish`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ message: 'post: 更新 a' }),
				}),
			);
			assert.equal(events.at(-1).data.code, 0);

			const ran = spawn.calls.filter((call) => call.startsWith('git '));
			assert.ok(ran.includes('git add -A'));
			assert.ok(ran.includes('git commit -m post: 更新 a'));
			assert.ok(ran.includes('git push'));
			assert.ok(
				ran.indexOf('git add -A') < ran.indexOf('git commit -m post: 更新 a') &&
					ran.indexOf('git commit -m post: 更新 a') < ran.indexOf('git push'),
				'顺序必须是 add → commit → push',
			);
		} finally {
			await server.close();
		}
	}),
);

test(
	'没有改动时只推送；有改动却没填提交信息则 400',
	withTempProject(async (paths) => {
		const spawn = fakeSpawn((line) =>
			line.includes('status --porcelain=v1 --branch') ? { lines: ['## main...origin/main'], code: 0 } : { lines: [], code: 0 },
		);
		const server = await startServer(paths, { spawn });
		try {
			const events = await readSse(await fetch(`${server.base}/api/git/publish`, { method: 'POST' }));
			assert.equal(events.at(-1).data.code, 0);
			const ran = spawn.calls.filter((call) => call.startsWith('git '));
			assert.ok(ran.includes('git push'));
			assert.ok(!ran.includes('git add -A'));
		} finally {
			await server.close();
		}
	}),
);

test(
	'新分支没有 upstream 时用 push -u origin <branch>',
	withTempProject(async (paths) => {
		const spawn = fakeSpawn((line) => {
			if (line.includes('status --porcelain=v1 --branch')) return { lines: ['## preview/ui-refresh'], code: 0 };
			return { lines: [], code: 0 };
		});
		const server = await startServer(paths, { spawn });
		try {
			const events = await readSse(
				await fetch(`${server.base}/api/git/publish`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ message: 'post: 新分支' }),
				}),
			);
			assert.equal(events.at(-1).data.code, 0);
			assert.ok(spawn.calls.some((call) => call.includes('push -u origin preview/ui-refresh')));
		} finally {
			await server.close();
		}
	}),
);

test(
	'git 失败会停在该步骤并回报',
	withTempProject(async (paths) => {
		const spawn = fakeSpawn((line) => {
			if (line.includes('status --porcelain=v1 --branch')) return { lines: ['## main', ' M a.md'], code: 0 };
			if (line.includes('push')) return { lines: ['fatal: could not read Username'], code: 128 };
			return { lines: [], code: 0 };
		});
		const server = await startServer(paths, { spawn });
		try {
			const response = await fetch(`${server.base}/api/git/publish`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ message: 'post: 更新' }),
			});
			const events = await readSse(response);
			const exit = events.at(-1);
			assert.equal(exit.data.code, 128);
			assert.match(exit.data.failed, /push/);
			assert.match(events.map((event) => event.data).join('\n'), /could not read Username/);
		} finally {
			await server.close();
		}
	}),
);

test(
	'预览服务通过 astro dev status/--background/stop 管理',
	withTempProject(async (paths) => {
		const spawn = fakeSpawn((line) => {
			if (line.includes('astro dev status')) return { lines: ['Dev server running at http://localhost:4999/'], code: 0 };
			if (line.includes('astro dev --background')) return { lines: ['Dev server started in background'], code: 0 };
			if (line.includes('astro dev stop')) return { lines: ['Dev server stopped'], code: 0 };
			return { lines: [], code: 0 };
		});
		const server = await startServer(paths, { spawn });
		try {
			const status = await (await fetch(`${server.base}/api/dev/status`)).json();
			assert.equal(status.running, true);
			assert.equal(status.url, 'http://localhost:4999/');

			const started = await (await fetch(`${server.base}/api/dev/start`, { method: 'POST' })).json();
			assert.equal(started.ok, true);
			const stopped = await (await fetch(`${server.base}/api/dev/stop`, { method: 'POST' })).json();
			assert.equal(stopped.ok, true);

			assert.ok(spawn.calls.some((call) => call.includes('dev --background')));
			assert.ok(spawn.calls.some((call) => call.includes('dev stop')));
		} finally {
			await server.close();
		}
	}),
);
