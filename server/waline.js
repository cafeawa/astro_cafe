import { createServer } from 'node:http';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = resolve(__dirname, '../data');
const dbPath = resolve(dataDir, 'waline.db');

process.env.SQLITE_PATH = dbPath;
process.env.JWT_TOKEN = process.env.JWT_TOKEN || 'waline-jwt-secret-change-me';
process.env.SECURE_DOMAINS = process.env.SECURE_DOMAINS || 'localhost,127.0.0.1';

const { default: createWaline } = await import('@waline/vercel');

const PORT = process.env.WALINE_PORT || 8360;
const handler = createWaline({ env: 'production' });

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
