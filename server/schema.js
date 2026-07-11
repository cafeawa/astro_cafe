import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Waline 数据库路径（唯一数据源，waline.js 与 init-db.js 共用）
export const dataDir = resolve(__dirname, '../data');
export const dbDir = resolve(dataDir, 'waline.db');
export const dbFile = resolve(dbDir, 'waline.sqlite');
export const jwtSecretFile = resolve(dbDir, '.jwt-secret');

// 建表 SQL —— 三张表统一带 createdAt 列与 localtime 默认值。
// 注意：insertedAt/createdAt/updatedAt 的 DEFAULT 用 localtime，避免时区偏差与 epoch 时间。
export const CREATE_TABLES_SQL = `
	CREATE TABLE IF NOT EXISTS wl_Comment (
		id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, url TEXT, comment TEXT,
		link TEXT, mail TEXT, nick TEXT, pid INTEGER DEFAULT 0, rid INTEGER DEFAULT 0,
		ua TEXT, ip TEXT, type TEXT DEFAULT 'comment', status TEXT DEFAULT 'approved',
		sticky INTEGER DEFAULT 0, "like" INTEGER DEFAULT 0, dislike INTEGER DEFAULT 0,
		insertedAt TEXT DEFAULT (datetime('now','localtime')),
		createdAt TEXT DEFAULT (datetime('now','localtime')),
		updatedAt TEXT DEFAULT (datetime('now','localtime'))
	);
	CREATE TABLE IF NOT EXISTS wl_Counter (
		id INTEGER PRIMARY KEY AUTOINCREMENT, url TEXT NOT NULL, time INTEGER DEFAULT 0,
		reaction0 INTEGER DEFAULT 0, reaction1 INTEGER DEFAULT 0, reaction2 INTEGER DEFAULT 0,
		reaction3 INTEGER DEFAULT 0, reaction4 INTEGER DEFAULT 0, reaction5 INTEGER DEFAULT 0,
		insertedAt TEXT DEFAULT (datetime('now','localtime')),
		createdAt TEXT DEFAULT (datetime('now','localtime')),
		updatedAt TEXT DEFAULT (datetime('now','localtime'))
	);
	CREATE TABLE IF NOT EXISTS wl_Users (
		id INTEGER PRIMARY KEY AUTOINCREMENT, display_name TEXT, email TEXT, url TEXT,
		nick TEXT, label TEXT, type TEXT DEFAULT 'guest', avatar TEXT,
		github TEXT, twitter TEXT, facebook TEXT, google TEXT, weibo TEXT, qq TEXT,
		password TEXT, is2fa INTEGER DEFAULT 0,
		insertedAt TEXT DEFAULT (datetime('now','localtime')),
		createdAt TEXT DEFAULT (datetime('now','localtime')),
		updatedAt TEXT DEFAULT (datetime('now','localtime'))
	);
`;

// 确保数据库目录与表存在（幂等）。返回数据库文件是否为本次新建。
export function ensureDatabase() {
	mkdirSync(dbDir, { recursive: true });
	const created = !existsSync(dbFile);
	const db = new Database(dbFile);
	db.exec(CREATE_TABLES_SQL);
	db.close();
	return created;
}

// 读取或生成持久化的 JWT 密钥（存放在已被 gitignore 的 data/waline.db/ 目录内）。
// 避免硬编码公开密钥；重启后密钥稳定，admin 会话不失效。
export function getJwtSecret() {
	mkdirSync(dbDir, { recursive: true });
	if (existsSync(jwtSecretFile)) {
		const saved = readFileSync(jwtSecretFile, 'utf8').trim();
		if (saved) return saved;
	}
	const secret = randomBytes(32).toString('hex');
	writeFileSync(jwtSecretFile, secret, { mode: 0o600 });
	return secret;
}
