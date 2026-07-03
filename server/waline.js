import { createApp } from '@waline/vercel';
import { createServer } from 'node:http';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = resolve(__dirname, '../data');

const app = createApp({
	// 使用 SQLite 存储，数据文件在 data/ 目录
	storage: 'sqlite',
	sqlite: {
		path: resolve(dataDir, 'waline.db'),
	},

	// 允许的域名（CORS）
	secureDomains: ['localhost', '127.0.0.1'],

	// 关闭 IP 查询（纯本地部署不需要）
	disableUserAgent: false,

	// 反垃圾：本地部署先关掉，后续可接入 Akismet
	preSave: () => Promise.resolve(),

	// 页面浏览量统计
	pageview: true,
});

const PORT = process.env.WALINE_PORT || 8360;

createServer(app).listen(PORT, () => {
	console.log(`Waline 评论服务已启动: http://localhost:${PORT}`);
	console.log(`数据文件: ${resolve(dataDir, 'waline.db')}`);
});
