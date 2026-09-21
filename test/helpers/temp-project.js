import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * 造一个临时“项目”（含 src/content/blog、src/assets、public），跑完自动清理。
 * 用法与 node:test 契合：test('...', withTempProject(async (paths) => { ... }))
 */
export function withTempProject(fn) {
	return async () => {
		const root = mkdtempSync(resolve(tmpdir(), 'astro-cafe-admin-'));
		const paths = {
			root,
			blogDir: join(root, 'src', 'content', 'blog'),
			assetsDir: join(root, 'src', 'assets'),
			publicDir: join(root, 'public'),
		};
		mkdirSync(paths.blogDir, { recursive: true });
		mkdirSync(paths.assetsDir, { recursive: true });
		mkdirSync(paths.publicDir, { recursive: true });

		try {
			await fn(paths);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	};
}
