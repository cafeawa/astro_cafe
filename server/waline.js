import { createServer } from 'node:http';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, existsSync } from 'node:fs';
import Database from 'better-sqlite3';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = resolve(__dirname, '../data');
const dbPath = resolve(dataDir, 'waline.db');
const dbFile = resolve(dbPath, 'waline.sqlite');

mkdirSync(dbPath, { recursive: true });

process.env.SQLITE_PATH = dbPath;
process.env.JWT_TOKEN = process.env.JWT_TOKEN || 'waline-jwt-secret-change-me';
process.env.SECURE_DOMAINS = process.env.SECURE_DOMAINS || 'localhost,127.0.0.1';

if (!existsSync(dbFile)) {
	const db = new Database(dbFile);
	db.exec(`
		CREATE TABLE IF NOT EXISTS wl_Comment (
			id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, url TEXT, comment TEXT,
			link TEXT, mail TEXT, nick TEXT, pid INTEGER DEFAULT 0, rid INTEGER DEFAULT 0,
			ua TEXT, ip TEXT, type TEXT DEFAULT 'comment', status TEXT DEFAULT 'approved',
			sticky INTEGER DEFAULT 0, "like" INTEGER DEFAULT 0, dislike INTEGER DEFAULT 0,
			insertedAt TEXT DEFAULT (datetime('now')),
			createdAt TEXT DEFAULT (datetime('now')),
			updatedAt TEXT DEFAULT (datetime('now'))
		);
		CREATE TABLE IF NOT EXISTS wl_Counter (
			id INTEGER PRIMARY KEY AUTOINCREMENT, url TEXT NOT NULL, time INTEGER DEFAULT 0,
			reaction0 INTEGER DEFAULT 0, reaction1 INTEGER DEFAULT 0, reaction2 INTEGER DEFAULT 0,
			reaction3 INTEGER DEFAULT 0, reaction4 INTEGER DEFAULT 0, reaction5 INTEGER DEFAULT 0,
			insertedAt TEXT DEFAULT (datetime('now')),
			createdAt TEXT DEFAULT (datetime('now')),
			updatedAt TEXT DEFAULT (datetime('now'))
		);
		CREATE TABLE IF NOT EXISTS wl_Users (
			id INTEGER PRIMARY KEY AUTOINCREMENT, display_name TEXT, email TEXT, url TEXT,
			nick TEXT, label TEXT, type TEXT DEFAULT 'guest', avatar TEXT,
			github TEXT, twitter TEXT, facebook TEXT, google TEXT, weibo TEXT, qq TEXT,
			password TEXT, is2fa INTEGER DEFAULT 0,
			insertedAt TEXT DEFAULT (datetime('now')),
			createdAt TEXT DEFAULT (datetime('now')),
			updatedAt TEXT DEFAULT (datetime('now'))
		);
	`);
	db.close();
	console.log('已创建数据库表:', dbFile);
}

const { default: createWaline } = await import('@waline/vercel');

const PORT = process.env.WALINE_PORT || 8360;
const handler = createWaline();

const server = createServer((req, res) => {
	handler(req, res).catch((err) => {
		console.error('Waline error:', err);
		if (!res.headersSent) {
			res.writeHead(500);
			res.end('Internal Server Error');
		}
	});
});

server.listen(PORT, () => {
	console.log(`Waline 评论服务: http://localhost:${PORT}`);
	console.log(`数据文件: ${dbPath}`);
});
