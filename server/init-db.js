import Database from 'better-sqlite3';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = resolve(__dirname, '../data');

mkdirSync(dataDir, { recursive: true });

const dbPath = resolve(dataDir, 'waline.db', 'waline.sqlite');
mkdirSync(resolve(dataDir, 'waline.db'), { recursive: true });

const db = new Database(dbPath);

db.exec(`
  CREATE TABLE IF NOT EXISTS wl_Comment (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    url TEXT,
    comment TEXT,
    link TEXT,
    mail TEXT,
    nick TEXT,
    pid INTEGER DEFAULT 0,
    rid INTEGER DEFAULT 0,
    ua TEXT,
    ip TEXT,
    type TEXT DEFAULT 'comment',
    status TEXT DEFAULT 'approved',
    sticky INTEGER DEFAULT 0,
    "like" INTEGER DEFAULT 0,
    dislike INTEGER DEFAULT 0,
    insertedAt TEXT,
    updatedAt TEXT
  );

  CREATE TABLE IF NOT EXISTS wl_Counter (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    url TEXT NOT NULL,
    time INTEGER DEFAULT 0,
    reaction0 INTEGER DEFAULT 0,
    reaction1 INTEGER DEFAULT 0,
    reaction2 INTEGER DEFAULT 0,
    reaction3 INTEGER DEFAULT 0,
    reaction4 INTEGER DEFAULT 0,
    reaction5 INTEGER DEFAULT 0,
    insertedAt TEXT,
    updatedAt TEXT
  );

  CREATE TABLE IF NOT EXISTS wl_Users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    display_name TEXT,
    email TEXT,
    url TEXT,
    nick TEXT,
    label TEXT,
    type TEXT DEFAULT 'guest',
    avatar TEXT,
    github TEXT,
    twitter TEXT,
    facebook TEXT,
    google TEXT,
    weibo TEXT,
    qq TEXT,
    password TEXT,
    is2fa INTEGER DEFAULT 0,
    insertedAt TEXT,
    updatedAt TEXT
  );
`);

console.log('Waline 数据库表已创建:', dbPath);
db.close();
