import { createServer } from 'node:http';
import { ensureDatabase, getJwtSecret, dbDir } from './schema.js';

const hasConfiguredStorage =
	process.env.LEAN_KEY ||
	process.env.MONGO_DB ||
	process.env.PG_DB ||
	process.env.POSTGRES_DATABASE ||
	process.env.SQLITE_PATH ||
	process.env.MYSQL_DB ||
	process.env.TIDB_DB ||
	process.env.GITHUB_TOKEN ||
	process.env.TCB_ENV;

if (!hasConfiguredStorage) {
	process.env.SQLITE_PATH = dbDir;
}
if (process.env.SQLITE_PATH) {
	process.env.JWT_TOKEN = process.env.JWT_TOKEN || getJwtSecret();
}
process.env.SECURE_DOMAINS = process.env.SECURE_DOMAINS || 'localhost,127.0.0.1';

if (process.env.SQLITE_PATH && ensureDatabase()) {
	console.log('已创建数据库表:', dbDir);
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
	console.log(`数据文件: ${dbDir}`);
});
