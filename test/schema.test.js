import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';

async function importSchema(dataDir) {
	process.env.WALINE_DATA_DIR = dataDir;
	return import(`../server/schema.js?test=${Date.now()}-${Math.random()}`);
}

function withTempDataDir(fn) {
	const dir = mkdtempSync(resolve(tmpdir(), 'astro-cafe-waline-'));
	return async () => {
		try {
			await fn(dir);
		} finally {
			delete process.env.WALINE_DATA_DIR;
			rmSync(dir, { recursive: true, force: true });
		}
	};
}

test(
	'ensureDatabase creates the Waline sqlite schema in the configured data directory',
	withTempDataDir(async (dir) => {
		const schema = await importSchema(dir);

		assert.equal(schema.dataDir, resolve(dir));
		assert.equal(schema.ensureDatabase(), true);
		assert.equal(schema.ensureDatabase(), false);
		assert.equal(existsSync(schema.dbFile), true);

		const db = new Database(schema.dbFile);
		try {
			const tables = db
				.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'wl_%' ORDER BY name")
				.all()
				.map((row) => row.name);

			assert.deepEqual(tables, ['wl_Comment', 'wl_Counter', 'wl_Users']);

			for (const table of tables) {
				const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
				assert.ok(columns.includes('insertedAt'), `${table} should include insertedAt`);
				assert.ok(columns.includes('createdAt'), `${table} should include createdAt`);
				assert.ok(columns.includes('updatedAt'), `${table} should include updatedAt`);
			}

			db.prepare("INSERT INTO wl_Comment (url, comment) VALUES ('/post', 'hello')").run();
			const comment = db.prepare('SELECT type, status, insertedAt, createdAt, updatedAt FROM wl_Comment').get();

			assert.equal(comment.type, 'comment');
			assert.equal(comment.status, 'approved');
			assert.match(comment.insertedAt, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
			assert.match(comment.createdAt, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
			assert.match(comment.updatedAt, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
		} finally {
			db.close();
		}
	})
);

test(
	'ensureDatabase migrates existing Waline tables that are missing timestamp columns',
	withTempDataDir(async (dir) => {
		const schema = await importSchema(dir);
		mkdirSync(schema.dbDir, { recursive: true });
		const db = new Database(schema.dbFile);
		try {
			db.exec(`
				CREATE TABLE wl_Comment (id INTEGER PRIMARY KEY AUTOINCREMENT, url TEXT, comment TEXT);
				CREATE TABLE wl_Counter (id INTEGER PRIMARY KEY AUTOINCREMENT, url TEXT NOT NULL, time INTEGER DEFAULT 0);
				CREATE TABLE wl_Users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT, nick TEXT);
			`);
			db.prepare("INSERT INTO wl_Comment (url, comment) VALUES ('/old', 'legacy')").run();
		} finally {
			db.close();
		}

		assert.equal(schema.ensureDatabase(), false);

		const migrated = new Database(schema.dbFile);
		try {
			for (const table of ['wl_Comment', 'wl_Counter', 'wl_Users']) {
				const columns = migrated.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
				assert.ok(columns.includes('insertedAt'), `${table} should include insertedAt`);
				assert.ok(columns.includes('createdAt'), `${table} should include createdAt`);
				assert.ok(columns.includes('updatedAt'), `${table} should include updatedAt`);
			}

			const comment = migrated.prepare('SELECT insertedAt, createdAt, updatedAt FROM wl_Comment').get();
			assert.match(comment.insertedAt, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
			assert.match(comment.createdAt, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
			assert.match(comment.updatedAt, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
		} finally {
			migrated.close();
		}
	})
);

test(
	'schema uses an explicit SQLITE_PATH when one is configured',
	withTempDataDir(async (dir) => {
		const sqliteDir = resolve(dir, 'custom-sqlite');
		process.env.SQLITE_PATH = sqliteDir;
		const schema = await importSchema(resolve(dir, 'ignored-data-dir'));

		try {
			assert.equal(schema.dbDir, sqliteDir);
			assert.equal(schema.dbFile, resolve(sqliteDir, 'waline.sqlite'));
			assert.equal(schema.ensureDatabase(), true);
			assert.equal(existsSync(schema.dbFile), true);
		} finally {
			delete process.env.SQLITE_PATH;
		}
	})
);

test(
	'getJwtSecret creates and reuses a persistent secret',
	withTempDataDir(async (dir) => {
		const schema = await importSchema(dir);

		const first = schema.getJwtSecret();
		const second = schema.getJwtSecret();

		assert.match(first, /^[a-f0-9]{64}$/);
		assert.equal(second, first);
		assert.equal(readFileSync(schema.jwtSecretFile, 'utf8'), first);

		writeFileSync(schema.jwtSecretFile, '\n');
		const regenerated = schema.getJwtSecret();

		assert.match(regenerated, /^[a-f0-9]{64}$/);
		assert.notEqual(regenerated, first);
		assert.equal(readFileSync(schema.jwtSecretFile, 'utf8'), regenerated);
	})
);
