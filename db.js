const Database = require("better-sqlite3");
const db = new Database("giveaway.db");
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS giveaways (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  message_id INTEGER NOT NULL,
  prize TEXT NOT NULL,
  sponsor TEXT NOT NULL,
  winners INTEGER NOT NULL,
  end_time INTEGER NOT NULL,
  ended INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  ended_at INTEGER,
  seed TEXT,
  seed_hash TEXT,
  canceled INTEGER DEFAULT 0,
  cancel_reason TEXT,
  announced INTEGER DEFAULT 0,
  announced_at INTEGER
);

CREATE TABLE IF NOT EXISTS participants (
  giveaway_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (giveaway_id, user_id)
);

CREATE TABLE IF NOT EXISTS winners (
  giveaway_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
`);

function addColumnIfMissing(table, column, type) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(r => r.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}

// migrations (safe to run many times)
addColumnIfMissing("giveaways", "seed", "TEXT");
addColumnIfMissing("giveaways", "seed_hash", "TEXT");
addColumnIfMissing("giveaways", "canceled", "INTEGER DEFAULT 0");
addColumnIfMissing("giveaways", "cancel_reason", "TEXT");
addColumnIfMissing("giveaways", "announced", "INTEGER DEFAULT 0");
addColumnIfMissing("giveaways", "announced_at", "INTEGER");

function setSetting(key, value) {
  db.prepare(`
    INSERT INTO settings(key,value) VALUES(?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value
  `).run(key, String(value));
}

function getSetting(key) {
  const r = db.prepare(`SELECT value FROM settings WHERE key=?`).get(key);
  return r ? r.value : null;
}

module.exports = { db, setSetting, getSetting };
