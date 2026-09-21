import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { withTempProject } from './helpers/temp-project.js';
import {
	assetAbsolutePath,
	defaultRoots,
	deletePost,
	formatDate,
	heroAssetFromField,
	heroImageField,
	isValidSlug,
	listAssets,
	listPosts,
	looksLikeImage,
	normalizeTags,
	parseFrontmatter,
	readPost,
	renderPost,
	resolveHeroAsset,
	safeAssetName,
	saveAsset,
	savePost,
	slugify,
	toYamlString,
} from '../server/frontmatter.js';

test('defaultRoots 指向仓库里约定俗成的三个目录', () => {
	const roots = defaultRoots('.');
	assert.equal(roots.blogDir, join(roots.root, 'src', 'content', 'blog'));
	assert.equal(roots.assetsDir, join(roots.root, 'src', 'assets'));
	assert.equal(roots.publicDir, join(roots.root, 'public'));
});

test('slugify / isValidSlug 与仓库现有 slug 风格一致', () => {
	assert.equal(slugify('Hello, World!'), 'hello-world');
	assert.equal(slugify('  2026 年度总结  '), '2026-年度总结');
	assert.equal(slugify("cafe's blog"), 'cafes-blog');
	assert.equal(slugify('🎉'), '');
	assert.equal(isValidSlug('my-post'), true);
	assert.equal(isValidSlug('文章-1'), true);
	assert.equal(isValidSlug('../evil'), false);
	assert.equal(isValidSlug('a/b'), false);
	assert.equal(isValidSlug(''), false);
});

test('normalizeTags 认中英文分隔符并去重', () => {
	assert.deepEqual(normalizeTags('Astro, 笔记，Astro；生活'), ['Astro', '笔记', '生活']);
	assert.deepEqual(normalizeTags(['a', ' a ', 'b']), ['a', 'b']);
	assert.deepEqual(normalizeTags(''), []);
});

test('formatDate 保留 ISO 日期并拒绝不存在的日期', () => {
	assert.equal(formatDate('2026-02-14'), '2026-02-14');
	assert.equal(formatDate("Jul 08 2022"), '2022-07-08');
	assert.throws(() => formatDate('2026-02-31'), /日期不存在/);
	assert.throws(() => formatDate('不是日期'), /无法解析日期/);
});

test('toYamlString 按 YAML 规则转义单引号', () => {
	assert.equal(toYamlString("It's"), "'It''s'");
	assert.equal(parseFrontmatter(`---\ntitle: ${toYamlString("It's")}\n---`).data.title, "It's");
});

test('parseFrontmatter 读得懂仓库现有写法，并保留未知字段', () => {
	const source = [
		'---',
		"title: 'First post'",
		"description: 'Lorem ipsum'",
		"pubDate: 'Jul 08 2022'",
		"heroImage: '../../assets/blog-placeholder-3.jpg'",
		"tags: ['Astro', '笔记']",
		'draft: true',
		'customField: keep-me',
		'---',
		'',
		'正文第一段。',
	].join('\n');

	const { data, body, extra } = parseFrontmatter(source);
	assert.equal(data.title, 'First post');
	assert.equal(data.pubDate, 'Jul 08 2022');
	assert.equal(data.heroImage, '../../assets/blog-placeholder-3.jpg');
	assert.deepEqual(data.tags, ['Astro', '笔记']);
	assert.equal(data.draft, true);
	assert.deepEqual(extra, ['customField: keep-me']);
	assert.match(body, /正文第一段。/);
});

test('renderPost 往返一致，并保留未知字段', () => {
	const fields = {
		title: "A 'quoted' 标题",
		description: '摘要',
		pubDate: '2026-02-14',
		updatedDate: '2026-02-20',
		heroImage: '../../assets/cover.png',
		tags: ['Astro', '笔记'],
		draft: true,
	};
	const content = renderPost({ fields, body: '\n\n正文\n\n', extra: ['customField: keep-me'] });
	const { data, body, extra } = parseFrontmatter(content);

	assert.equal(data.title, "A 'quoted' 标题");
	assert.equal(data.updatedDate, '2026-02-20');
	assert.deepEqual(data.tags, ['Astro', '笔记']);
	assert.equal(data.draft, true);
	assert.deepEqual(extra, ['customField: keep-me']);
	assert.equal(body.trim(), '正文');
	assert.match(content, /^---\n/);
});

test('renderPost 对空正文不会留出一堆空行', () => {
	assert.equal(renderPost({ fields: { title: 'T', description: '', pubDate: '2026-02-14' }, body: '' }).endsWith('---\n'), true);
});

test(
	'listPosts 按日期倒序，带草稿标记与封面图解析',
	withTempProject(async (paths) => {
		writeFileSync(
			join(paths.blogDir, 'older.md'),
			renderPost({ fields: { title: 'Older', description: '', pubDate: '2024-01-01', tags: ['笔记'] }, body: 'x' }),
		);
		writeFileSync(
			join(paths.blogDir, 'newer.md'),
			renderPost({ fields: { title: 'Newer', description: '', pubDate: '2026-02-14', draft: true }, body: 'y' }),
		);
		writeFileSync(join(paths.blogDir, 'notes.txt'), 'not a post');

		const posts = await listPosts(paths);
		assert.deepEqual(posts.map((post) => post.slug), ['newer', 'older']);
		assert.equal(posts[0].draft, true);
		assert.equal(posts[1].draft, false);
		assert.deepEqual(posts[1].tags, ['笔记']);
		assert.equal(posts[1].pubDate, '2024-01-01');
	}),
);

test(
	'readPost 取回正文与项目相对的封面图路径',
	withTempProject(async (paths) => {
		writeFileSync(join(paths.assetsDir, 'cover.png'), 'fake');
		await savePost(
			{ title: 'My Post', description: ' 摘要 ', pubDate: '2026-02-14', heroImage: 'src/assets/cover.png', body: '正文' },
			paths,
		);

		const post = await readPost('my-post', paths);
		assert.equal(post.title, 'My Post');
		assert.equal(post.body, '正文');
		assert.equal(post.heroImage, '../../assets/cover.png');
		assert.equal(post.heroAsset, 'src/assets/cover.png');
		assert.equal(post.mdx, false);
	}),
);

test(
	'savePost 新建、更新、改名、换扩展名，并拦住重名',
	withTempProject(async (paths) => {
		await savePost({ title: 'Hello World', description: 'a', pubDate: '2026-01-01', body: 'one' }, paths);
		assert.equal(existsSync(join(paths.blogDir, 'hello-world.md')), true);
		assert.match(readFileSync(join(paths.blogDir, 'hello-world.md'), 'utf8'), /title: 'Hello World'/);

		// 更新同一篇
		await savePost(
			{ originalSlug: 'hello-world', title: 'Hello World', description: 'b', pubDate: '2026-01-01', body: 'two' },
			paths,
		);
		assert.match(readFileSync(join(paths.blogDir, 'hello-world.md'), 'utf8'), /two/);

		// 重名：没有 originalSlug 时视为新建
		await assert.rejects(
			() => savePost({ title: 'Hello World', description: '', pubDate: '2026-01-01' }, paths),
			/already|已存在/,
		);

		// 改名：旧文件被删掉
		await savePost({ originalSlug: 'hello-world', slug: 'renamed', title: 'Renamed', description: '', pubDate: '2026-01-01' }, paths);
		assert.equal(existsSync(join(paths.blogDir, 'hello-world.md')), false);
		assert.equal(existsSync(join(paths.blogDir, 'renamed.md')), true);

		// 换扩展名：.md → .mdx
		await savePost(
			{ originalSlug: 'renamed', slug: 'renamed', title: 'Renamed', description: '', pubDate: '2026-01-01', mdx: true },
			paths,
		);
		assert.equal(existsSync(join(paths.blogDir, 'renamed.md')), false);
		assert.equal(existsSync(join(paths.blogDir, 'renamed.mdx')), true);

		// 删除
		await deletePost('renamed', paths);
		assert.equal(existsSync(join(paths.blogDir, 'renamed.mdx')), false);
		await assert.rejects(() => deletePost('renamed', paths), /找不到文章/);
	}),
);

test(
	'savePost 会拦下空标题和没法生成 slug 的标题',
	withTempProject(async (paths) => {
		await assert.rejects(() => savePost({ title: '   ' }, paths), /标题不能为空/);
		await assert.rejects(() => savePost({ title: '🎉' }, paths), /无法从标题生成 slug/);
	}),
);

test(
	'resolveHeroAsset 支持文件名、项目路径，并挡住 public/ 与不存在的图',
	withTempProject(async (paths) => {
		writeFileSync(join(paths.assetsDir, 'cover.png'), 'fake');
		writeFileSync(join(paths.publicDir, 'public-cover.png'), 'fake');

		assert.equal(resolveHeroAsset('cover.png', paths), 'src/assets/cover.png');
		assert.equal(resolveHeroAsset('src/assets/cover.png', paths), 'src/assets/cover.png');
		assert.equal(resolveHeroAsset('', paths), null);
		assert.throws(() => resolveHeroAsset('public/public-cover.png', paths), /public\//);
		assert.throws(() => resolveHeroAsset('nope.png', paths), /封面图不存在/);
	}),
);

test('heroImageField 生成 image() 需要的相对路径', () => {
	assert.equal(heroImageField('src/assets/cover.png', 'my-post', false), '../../assets/cover.png');
	assert.equal(heroImageField('src/assets/cover.png', 'my-post', true), '../../assets/cover.png');
	assert.equal(heroImageField('src/content/blog/local.png', 'my-post', false), './local.png');
});

test(
	'heroAssetFromField 解析不了就返回 null',
	withTempProject(async (paths) => {
		writeFileSync(join(paths.assetsDir, 'cover.png'), 'fake');
		assert.equal(heroAssetFromField('../../assets/cover.png', paths), 'src/assets/cover.png');
		assert.equal(heroAssetFromField('../../assets/missing.png', paths), null);
		assert.equal(heroAssetFromField(undefined, paths), null);
	}),
);

/** 只保留文件头的最小假图：saveAsset 会校验字节，纯文本会被拒 */
const FAKE_PNG = Buffer.concat([
	Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
	Buffer.from('fake-png-data'),
]);

test('looksLikeImage 按文件头认格式', () => {
	assert.equal(looksLikeImage(FAKE_PNG, '.png'), true);
	assert.equal(looksLikeImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0]), '.jpg'), true);
	assert.equal(looksLikeImage(Buffer.from('GIF89a....'), '.gif'), true);
	assert.equal(looksLikeImage(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')]), '.webp'), true);
	assert.equal(looksLikeImage(Buffer.concat([Buffer.alloc(4), Buffer.from('ftypavif')]), '.avif'), true);
	assert.equal(looksLikeImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), '.svg'), true);

	assert.equal(looksLikeImage(Buffer.from('not an image'), '.png'), false);
	assert.equal(looksLikeImage(Buffer.alloc(0), '.png'), false);
	assert.equal(looksLikeImage(FAKE_PNG, '.svg'), false);
});

test(
	'listAssets / saveAsset / assetAbsolutePath',
	withTempProject(async (paths) => {
		const asset = await saveAsset('Cover Image.PNG', FAKE_PNG, paths);
		assert.equal(asset.path, 'src/assets/cover-image.png');
		assert.equal(existsSync(join(paths.assetsDir, 'cover-image.png')), true);

		const second = await saveAsset('Cover Image.PNG', FAKE_PNG, paths);
		assert.equal(second.name, 'cover-image-1.png');

		await assert.rejects(() => saveAsset('note.txt', FAKE_PNG, paths), /不支持的图片格式/);
		await assert.rejects(() => saveAsset('empty.png', Buffer.alloc(0), paths), /上传内容为空/);
		await assert.rejects(() => saveAsset('broken.png', Buffer.from('这不是图片'), paths), /不是有效的 PNG 图片/);

		const assets = await listAssets(paths);
		assert.deepEqual(assets.map((entry) => entry.name).sort(), ['cover-image-1.png', 'cover-image.png']);

		assert.equal(assetAbsolutePath('src/assets/cover-image.png', paths), join(paths.assetsDir, 'cover-image.png'));
		assert.throws(() => assetAbsolutePath('../../secret.txt', paths), /只允许访问 src\/assets/);
		assert.throws(() => assetAbsolutePath('src/content/blog/x.md', paths), /只允许访问 src\/assets/);
	}),
);

test('safeAssetName 只认图片扩展名', () => {
	const roots = { root: process.cwd(), assetsDir: join(process.cwd(), 'src', 'assets') };
	assert.equal(safeAssetName('photo.JPEG', roots), 'photo.jpeg');
	assert.throws(() => safeAssetName('script.js', roots), /不支持的图片格式/);
});
