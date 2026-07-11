import { ensureDatabase, dbFile } from './schema.js';

// 手动初始化数据库（与 waline.js 共用同一份 schema，避免结构漂移）
ensureDatabase();

console.log('Waline 数据库表已创建:', dbFile);
