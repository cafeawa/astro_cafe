import { fileURLToPath } from 'node:url';

process.loadEnvFile(fileURLToPath(new URL('./waline-production.env', import.meta.url)));
await import('./waline.js');
