/**
 * 文章文件的读写与 frontmatter 处理。
 *
 * 这里只做纯逻辑和文件操作，不碰 HTTP —— 便于在 test/ 里直接测。
 * frontmatter 的字段定义与 src/content.config.ts 保持一致：
 *   title / description / pubDate 必填，updatedDate / heroImage / tags / draft 可选。
 */
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif', '.gif', '.svg']);
export const POST_EXTENSIONS = ['.md', '.mdx'];

/** 已知 frontmatter 字段；其它字段会被原样保留（extra） */
const KNOWN_KEYS = new Set(['title', 'description', 'pubDate', 'updatedDate', 'heroImage', 'tags', 'draft']);

// 允许 ASCII 与中日韩汉字，和仓库现有 slug 风格一致
const CJK_RANGE = '\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff';
const SLUG_PATTERN = new RegExp(`^[a-z0-9${CJK_RANGE}]+(?:-[a-z0-9${CJK_RANGE}]+)*$`);

export const DEFAULT_BODY = ['正文从这里开始。', '', '## 小标题', '', '更多内容……'].join('\n');

export function defaultRoots(root) {
	const resolved = path.resolve(root);
	return {
		root: resolved,
		blogDir: path.join(resolved, 'src', 'content', 'blog'),
		assetsDir: path.join(resolved, 'src', 'assets'),
		publicDir: path.join(resolved, 'public'),
	};
}

export function httpError(status, message) {
	const error = new Error(message);
	error.status = status;
	return error;
}

/* ------------------------------------------------------------------ *
 * 值处理
 * ------------------------------------------------------------------ */

export function slugify(value) {
	return String(value ?? '')
		.normalize('NFKC')
		.toLowerCase()
		.replace(/['"‘’“”]/g, '')
		.replace(new RegExp(`[^a-z0-9${CJK_RANGE}]+`, 'g'), '-')
		.replace(/-{2,}/g, '-')
		.replace(/^-+|-+$/g, '');
}

export function isValidSlug(slug) {
	return SLUG_PATTERN.test(String(slug ?? ''));
}

/** 中英文逗号、分号、顿号都算分隔符，去重保序 */
export function normalizeTags(input) {
	const list = Array.isArray(input) ? input : String(input ?? '').split(/[,，、;；]/);
	const seen = new Set();
	const tags = [];
	for (const raw of list) {
		const tag = String(raw).trim();
		if (!tag || seen.has(tag)) continue;
		seen.add(tag);
		tags.push(tag);
	}
	return tags;
}

/** 一律输出 YYYY-MM-DD；已经是合法 ISO 日期就原样保留，避开时区把日期挪一天 */
export function formatDate(value = new Date()) {
	if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.trim())) {
		const iso = value.trim();
		const [year, month, day] = iso.split('-').map(Number);
		const probe = new Date(Date.UTC(year, month - 1, day));
		if (
			probe.getUTCFullYear() !== year ||
			probe.getUTCMonth() !== month - 1 ||
			probe.getUTCDate() !== day
		) {
			throw httpError(400, `日期不存在：${iso}`);
		}
		return iso;
	}

	const date = value instanceof Date ? value : new Date(value);
	if (Number.isNaN(date.getTime())) throw httpError(400, `无法解析日期：${value}`);
	const pad = (n) => String(n).padStart(2, '0');
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 读出来的日期可能写成 'Jul 08 2022'，统一转成 YYYY-MM-DD；转不了就返回 null */
export function toIsoDateOrNull(value) {
	if (value === undefined || value === null || value === '') return null;
	try {
		return formatDate(value);
	} catch {
		return null;
	}
}

export function toYamlString(value) {
	return `'${String(value).replace(/'/g, "''")}'`;
}

/* ------------------------------------------------------------------ *
 * frontmatter 读写
 * ------------------------------------------------------------------ */

export function buildFrontmatter({
	title,
	description = '',
	pubDate = new Date(),
	updatedDate,
	heroImage,
	tags = [],
	draft = false,
	extra = [],
}) {
	const tagsList = normalizeTags(tags);
	const lines = [
		'---',
		`title: ${toYamlString(title)}`,
		`description: ${toYamlString(description)}`,
		`pubDate: ${toYamlString(formatDate(pubDate))}`,
	];
	if (updatedDate) lines.push(`updatedDate: ${toYamlString(formatDate(updatedDate))}`);
	if (heroImage) lines.push(`heroImage: ${toYamlString(heroImage)}`);
	if (tagsList.length) lines.push(`tags: [${tagsList.map(toYamlString).join(', ')}]`);
	if (draft) lines.push('draft: true');
	for (const line of extra) lines.push(line);
	lines.push('---');
	return lines.join('\n');
}

function parseScalar(raw) {
	const value = String(raw).trim();
	if (value === '') return '';
	if (value === 'true') return true;
	if (value === 'false') return false;
	if (value === 'null' || value === '~') return null;
	if (value.startsWith('[') && value.endsWith(']')) {
		const inner = value.slice(1, -1).trim();
		if (!inner) return [];
		return (inner.match(/'[^']*'|"[^"]*"|[^,]+/g) ?? [])
			.map((part) => parseScalar(part))
			.filter((part) => part !== '');
	}
	const quoted = /^'([\s\S]*)'$/.exec(value) ?? /^"([\s\S]*)"$/.exec(value);
	if (quoted) return quoted[1].replace(/''/g, "'");
	return value;
}

/** 返回 { data, body, extra }；extra 是无法识别的原始行，保存时原样写回 */
export function parseFrontmatter(source) {
	const text = String(source ?? '');
	const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/.exec(text);
	if (!match) return { data: {}, body: text, extra: [] };

	const data = {};
	const extra = [];
	for (const line of match[1].split(/\r?\n/)) {
		const kv = /^([A-Za-z_][\w-]*):[ \t]*(.*)$/.exec(line);
		if (!kv) {
			if (line.trim()) extra.push(line);
			continue;
		}
		if (KNOWN_KEYS.has(kv[1])) data[kv[1]] = parseScalar(kv[2]);
		else extra.push(line);
	}

	return { data, body: text.slice(match[0].length), extra };
}

export function renderPost({ fields, body, extra = [] }) {
	const frontmatter = buildFrontmatter({ ...fields, extra });
	const normalized = String(body ?? '').replace(/^\r?\n+/, '').replace(/\s+$/, '');
	return normalized ? `${frontmatter}\n\n${normalized}\n` : `${frontmatter}\n`;
}

/* ------------------------------------------------------------------ *
 * 封面图路径
 * ------------------------------------------------------------------ */

function isInside(parent, target) {
	const relative = path.relative(parent, target);
	return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * 把界面上给的封面图（项目相对路径 / 裸文件名 / 绝对路径）解析成
 * 项目相对 posix 路径，例如 'src/assets/cover.png'。
 */
export function resolveHeroAsset(input, roots) {
	const raw = String(input ?? '').trim();
	if (!raw) return null;

	const candidates = path.isAbsolute(raw)
		? [raw]
		: [path.resolve(roots.root, raw), path.resolve(roots.assetsDir, raw)];
	const absolute = candidates.find((candidate) => existsSync(candidate) && !isInside(roots.publicDir, candidate));
	if (!absolute) {
		if (candidates.some((candidate) => isInside(roots.publicDir, candidate))) {
			throw httpError(400, '封面图不能放在 public/ 下（frontmatter 的 heroImage 用 image() 校验，只支持被 Astro 处理的图片，请放到 src/assets/）');
		}
		throw httpError(400, `封面图不存在：${raw}`);
	}
	if (!isInside(roots.root, absolute)) throw httpError(400, `封面图必须在项目目录内：${raw}`);

	return path.relative(roots.root, absolute).split(path.sep).join('/');
}

/** 项目相对路径 → frontmatter 里相对文章文件写法的路径（image() 需要） */
export function heroImageField(assetPath, slug, mdx = false) {
	const postFile = path.join('src', 'content', 'blog', `${slug}${mdx ? '.mdx' : '.md'}`);
	const absolute = path.join(assetPath.split('/').join(path.sep));
	const relative = path.relative(path.dirname(postFile), absolute).split(path.sep).join('/');
	return relative.startsWith('.') ? relative : `./${relative}`;
}

/** frontmatter 里的写法 → 项目相对 posix 路径；解析不了或文件不在项目内返回 null */
export function heroAssetFromField(fieldValue, roots) {
	if (!fieldValue) return null;
	const absolute = path.isAbsolute(fieldValue)
		? fieldValue
		: path.resolve(roots.blogDir, String(fieldValue));
	if (!isInside(roots.root, absolute) || !existsSync(absolute)) return null;
	return path.relative(roots.root, absolute).split(path.sep).join('/');
}

/* ------------------------------------------------------------------ *
 * 文章
 * ------------------------------------------------------------------ */

export function postFileFor(slug, ext, roots) {
	return path.join(roots.blogDir, `${slug}${ext}`);
}

export function findPostFile(slug, roots) {
	for (const ext of POST_EXTENSIONS) {
		const file = postFileFor(slug, ext, roots);
		if (existsSync(file)) return { file, ext };
	}
	return null;
}

function metaFrom(slug, ext, file, parsed, mtimeMs) {
	const { data } = parsed;
	return {
		slug,
		fileName: `${slug}${ext}`,
		mdx: ext === '.mdx',
		title: typeof data.title === 'string' && data.title ? data.title : slug,
		description: typeof data.description === 'string' ? data.description : '',
		pubDate: toIsoDateOrNull(data.pubDate),
		updatedDate: toIsoDateOrNull(data.updatedDate),
		tags: normalizeTags(data.tags ?? []),
		draft: data.draft === true,
		heroImage: typeof data.heroImage === 'string' ? data.heroImage : null,
		mtimeMs: mtimeMs ?? null,
		file,
	};
}

/** 列表：只需要元信息，不读正文；按日期倒序 */
export async function listPosts(roots) {
	const entries = await readdir(roots.blogDir, { withFileTypes: true }).catch(() => []);
	const posts = [];

	for (const entry of entries) {
		if (!entry.isFile()) continue;
		const ext = path.extname(entry.name).toLowerCase();
		if (!POST_EXTENSIONS.includes(ext)) continue;

		const file = path.join(roots.blogDir, entry.name);
		const slug = entry.name.slice(0, -ext.length);
		const [source, info] = await Promise.all([readFile(file, 'utf8'), stat(file)]);
		const parsed = parseFrontmatter(source);
		posts.push({
			...metaFrom(slug, ext, file, parsed, info.mtimeMs),
			heroAsset: heroAssetFromField(parsed.data.heroImage, roots),
		});
	}

	return posts.sort((a, b) => {
		const left = a.pubDate ?? '';
		const right = b.pubDate ?? '';
		if (left !== right) return right.localeCompare(left);
		return a.slug.localeCompare(b.slug);
	});
}

export async function readPost(slug, roots) {
	const found = findPostFile(slug, roots);
	if (!found) throw httpError(404, `找不到文章：${slug}`);

	const source = await readFile(found.file, 'utf8');
	const parsed = parseFrontmatter(source);
	const info = await stat(found.file);

	return {
		...metaFrom(slug, found.ext, found.file, parsed, info.mtimeMs),
		heroAsset: heroAssetFromField(parsed.data.heroImage, roots),
		body: parsed.body.replace(/^\r?\n+/, '').replace(/\s+$/, ''),
		extra: parsed.extra,
	};
}

export async function savePost(payload, roots) {
	const title = String(payload.title ?? '').trim();
	if (!title) throw httpError(400, '标题不能为空');

	const existing = payload.originalSlug ? findPostFile(String(payload.originalSlug), roots) : null;
	const slug = slugify(payload.slug ?? title);
	if (!slug) throw httpError(400, '无法从标题生成 slug（标题里没有可用的字母/数字/汉字），请手动填写');
	if (!isValidSlug(slug)) throw httpError(400, `slug 不合法：${slug}（只允许小写字母、数字、汉字和连字符）`);

	const mdx = payload.mdx === undefined ? Boolean(existing && existing.ext === '.mdx') : Boolean(payload.mdx);
	const ext = mdx ? '.mdx' : '.md';
	const target = postFileFor(slug, ext, roots);
	const conflict = findPostFile(slug, roots);
	if (conflict && (!existing || conflict.file !== existing.file)) {
		throw httpError(409, `已存在同名文章：${path.basename(conflict.file)}`);
	}

	let heroImage = null;
	const rawHero = String(payload.heroImage ?? '').trim();
	if (rawHero) {
		// '.' 开头视为已经是相对文章文件的写法，直接沿用；否则按项目路径/文件名解析
		heroImage = rawHero.startsWith('.') ? rawHero : heroImageField(resolveHeroAsset(rawHero, roots), slug, mdx);
	}

	const content = renderPost({
		fields: {
			title,
			description: String(payload.description ?? ''),
			pubDate: payload.pubDate || new Date(),
			updatedDate: payload.updatedDate || undefined,
			heroImage: heroImage ?? undefined,
			tags: payload.tags ?? [],
			draft: payload.draft === true,
		},
		body: payload.body ?? DEFAULT_BODY,
		extra: existing ? parseFrontmatter(await readFile(existing.file, 'utf8')).extra : [],
	});

	await mkdir(roots.blogDir, { recursive: true });
	await writeFile(target, content, 'utf8');

	// slug 或扩展名变了：删掉旧文件
	if (existing && existing.file !== target) await rm(existing.file, { force: true });

	return readPost(slug, roots);
}

export async function deletePost(slug, roots) {
	const found = findPostFile(slug, roots);
	if (!found) throw httpError(404, `找不到文章：${slug}`);
	await rm(found.file, { force: true });
	return { slug, file: path.basename(found.file) };
}

/* ------------------------------------------------------------------ *
 * 图片
 * ------------------------------------------------------------------ */

export async function listAssets(roots) {
	const found = [];

	async function walk(dir) {
		const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
		for (const entry of entries) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) await walk(full);
			else if (IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
				const info = await stat(full);
				found.push({
					path: path.relative(roots.root, full).split(path.sep).join('/'),
					name: entry.name,
					size: info.size,
					mtimeMs: info.mtimeMs,
				});
			}
		}
	}

	await walk(roots.assetsDir);
	return found.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

export function safeAssetName(fileName, roots) {
	const base = path.basename(String(fileName || 'image'));
	const ext = path.extname(base).toLowerCase();
	if (!IMAGE_EXTENSIONS.has(ext)) throw httpError(400, `不支持的图片格式：${ext || '(没有扩展名)'}`);

	// 用原名长度截断，避免 Cover.PNG 这类大小写不一致时留下 "-png" 尾巴
	const stem = slugify(base.slice(0, base.length - path.extname(base).length)) || 'image';
	let candidate = `${stem}${ext}`;
	let index = 1;
	while (existsSync(path.join(roots.assetsDir, candidate))) {
		candidate = `${stem}-${index}${ext}`;
		index += 1;
	}
	return candidate;
}

export async function saveAsset(fileName, buffer, roots) {
	if (!buffer?.length) throw httpError(400, '上传内容为空');

	const ext = path.extname(path.basename(String(fileName || 'image'))).toLowerCase();
	if (!IMAGE_EXTENSIONS.has(ext)) throw httpError(400, `不支持的图片格式：${ext || '(没有扩展名)'}`);
	// 只改扩展名的坏文件会让 Astro 读不到图片元数据，进而把整站渲染拖垮，这里先挡住
	if (!looksLikeImage(buffer, ext)) {
		throw httpError(400, `上传的内容不是有效的 ${ext.slice(1).toUpperCase()} 图片（文件可能损坏，或者只是改了扩展名）`);
	}

	const name = safeAssetName(fileName, roots);
	await mkdir(roots.assetsDir, { recursive: true });
	await writeFile(path.join(roots.assetsDir, name), buffer);
	return { path: `src/assets/${name}`, name, size: buffer.length };
}

/** 按文件头判断字节是否真的是这种图片 */
export function looksLikeImage(buffer, ext) {
	const bytes = buffer ?? Buffer.alloc(0);
	const first = (...signature) => signature.every((byte, index) => bytes[index] === byte);
	const ascii = (offset, text) =>
		[...text].every((char, index) => bytes[offset + index] === char.charCodeAt(0));

	switch (String(ext ?? '').toLowerCase()) {
		case '.png':
			return first(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
		case '.jpg':
		case '.jpeg':
			return first(0xff, 0xd8, 0xff);
		case '.gif':
			return ascii(0, 'GIF8');
		case '.webp':
			return ascii(0, 'RIFF') && ascii(8, 'WEBP');
		case '.avif':
			return ascii(4, 'ftyp') && (ascii(8, 'avif') || ascii(8, 'avis'));
		case '.svg':
			return /<svg[\s>]/i.test(bytes.toString('utf8', 0, 1024));
		default:
			return false;
	}
}

export function assetAbsolutePath(projectRelative, roots) {
	const absolute = path.resolve(roots.root, String(projectRelative ?? ''));
	if (!isInside(roots.assetsDir, absolute)) throw httpError(403, '只允许访问 src/assets 下的图片');
	return absolute;
}
