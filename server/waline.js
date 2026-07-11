import { createServer } from 'node:http';
import { ensureDatabase, dbDir } from './schema.js';

process.env.SQLITE_PATH = dbDir;
process.env.JWT_TOKEN = process.env.JWT_TOKEN || 'waline-jwt-secret-change-me';
process.env.SECURE_DOMAINS = process.env.SECURE_DOMAINS || 'localhost,127.0.0.1';

if (ensureDatabase()) {
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
