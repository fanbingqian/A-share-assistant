'use strict';

/**
 * 对话会话存储（SQLite · Node 内置 node:sqlite，零第三方依赖）
 * - chat_sessions / chat_messages + FTS5(trigram) 中文子串搜索
 * - 一次性从 data/journal/conversations.jsonl 迁移历史对话
 * - 原始经验流 conversations.jsonl 仍由 server.js 追加，本模块不覆盖它
 */

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const DB_PATH = path.join(__dirname, '..', 'data', 'journal', 'chat.db');
const LEGACY_FILE = path.join(__dirname, '..', 'data', 'journal', 'conversations.jsonl');

let db = null;
let initError = null;

function newId() {
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

function init() {
  if (db) return db;
  try {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    db = new DatabaseSync(DB_PATH);
    db.exec('PRAGMA journal_mode=WAL');
    db.exec('PRAGMA foreign_keys=ON');
    db.exec(`
      CREATE TABLE IF NOT EXISTS chat_sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        message_count INTEGER NOT NULL DEFAULT 0,
        source TEXT NOT NULL DEFAULT 'ui'
      );
      CREATE TABLE IF NOT EXISTS chat_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        ts INTEGER NOT NULL,
        module TEXT,
        backend TEXT,
        FOREIGN KEY(session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages(session_id, id);
      CREATE VIRTUAL TABLE IF NOT EXISTS chat_messages_fts USING fts5(
        content, content='chat_messages', content_rowid='id', tokenize='trigram'
      );
      CREATE TRIGGER IF NOT EXISTS chat_messages_ai AFTER INSERT ON chat_messages BEGIN
        INSERT INTO chat_messages_fts(rowid, content) VALUES (new.id, new.content);
      END;
      CREATE TRIGGER IF NOT EXISTS chat_messages_ad AFTER DELETE ON chat_messages BEGIN
        INSERT INTO chat_messages_fts(chat_messages_fts, rowid, content) VALUES('delete', old.id, old.content);
      END;
      CREATE TRIGGER IF NOT EXISTS chat_messages_au AFTER UPDATE ON chat_messages BEGIN
        INSERT INTO chat_messages_fts(chat_messages_fts, rowid, content) VALUES('delete', old.id, old.content);
        INSERT INTO chat_messages_fts(rowid, content) VALUES (new.id, new.content);
      END;
      CREATE TABLE IF NOT EXISTS chat_meta (key TEXT PRIMARY KEY, value TEXT);
    `);
    migrateLegacy();
    ensureCurrent();
    return db;
  } catch (e) {
    initError = e && e.message ? e.message : String(e);
    db = null;
    return null;
  }
}

function getMeta(key) {
  if (!init()) return null;
  const r = db.prepare('SELECT value FROM chat_meta WHERE key=?').get(key);
  return r ? r.value : null;
}
function setMeta(key, value) {
  if (!init()) return;
  db.prepare('INSERT INTO chat_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, String(value));
}

function rowToSession(r) {
  if (!r) return null;
  return {
    id: r.id, title: r.title,
    createdAt: r.created_at, updatedAt: r.updated_at,
    messageCount: r.message_count, source: r.source || 'ui'
  };
}

/** 从 JSONL 经验流一次性迁移（只做一次，不改动原文件） */
function migrateLegacy() {
  if (getMeta('legacy_migrated')) return;
  let rows = [];
  try {
    if (fs.existsSync(LEGACY_FILE)) {
      rows = fs.readFileSync(LEGACY_FILE, 'utf8').split('\n').map(s => s.trim()).filter(Boolean)
        .map(line => { try { return JSON.parse(line); } catch (_) { return null; } })
        .filter(r => r && r.question && r.answer);
    }
  } catch (_) {}
  if (rows.length) {
    const now = Date.now();
    const sid = 'legacy-import';
    let count = 0;
    try {
      db.exec('BEGIN');
      db.prepare('INSERT OR IGNORE INTO chat_sessions(id,title,created_at,updated_at,message_count,source) VALUES(?,?,?,?,?,?)')
        .run(sid, '历史对话（导入）', now, now, rows.length * 2, 'legacy');
      const ins = db.prepare('INSERT INTO chat_messages(session_id,role,content,ts,module,backend) VALUES(?,?,?,?,?,?)');
      for (const r of rows) {
        const ts = Date.parse(r.ts) || now;
        ins.run(sid, 'user', String(r.question).slice(0, 4000), ts, r.module || '对话', null);
        ins.run(sid, 'assistant', String(r.answer).slice(0, 8000), ts + 1, r.module || '对话', r.backend || null);
        count += 2;
      }
      db.prepare('UPDATE chat_sessions SET message_count=? WHERE id=?').run(count, sid);
      db.exec('COMMIT');
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch (_) {}
    }
  }
  setMeta('legacy_migrated', '1');
}

function ensureCurrent() {
  const cur = getMeta('currentSessionId');
  if (cur && getSession(cur)) return;
  const list = listSessions();
  if (list.length) { setMeta('currentSessionId', list[0].id); return; }
  const s = createSession('新会话');
  if (s) setMeta('currentSessionId', s.id);
}

function listSessions() {
  if (!init()) return [];
  return db.prepare('SELECT * FROM chat_sessions ORDER BY updated_at DESC LIMIT 100').all().map(rowToSession);
}

function getSession(id) {
  if (!init() || !id) return null;
  return rowToSession(db.prepare('SELECT * FROM chat_sessions WHERE id=?').get(String(id)));
}

function createSession(title) {
  if (!init()) return null;
  const now = Date.now();
  const id = newId();
  db.prepare('INSERT INTO chat_sessions(id,title,created_at,updated_at,message_count,source) VALUES(?,?,?,?,0,?)')
    .run(id, String(title || '新会话').slice(0, 60), now, now, 'ui');
  return rowToSession(db.prepare('SELECT * FROM chat_sessions WHERE id=?').get(id));
}

function renameSession(id, title) {
  if (!init() || !id) return null;
  const t = String(title || '').trim().slice(0, 60);
  if (!t) return null;
  db.prepare('UPDATE chat_sessions SET title=?, updated_at=? WHERE id=?').run(t, Date.now(), String(id));
  return getSession(id);
}

function deleteSession(id) {
  if (!init() || !id) return { ok: false, error: '缺少会话 id' };
  const sid = String(id);
  try {
    db.exec('BEGIN');
    db.prepare('DELETE FROM chat_messages WHERE session_id=?').run(sid);
    db.prepare('DELETE FROM chat_sessions WHERE id=?').run(sid);
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) {}
    return { ok: false, error: e.message };
  }
  if (getMeta('currentSessionId') === sid) {
    const list = listSessions();
    setMeta('currentSessionId', list.length ? list[0].id : (createSession('新会话') || {}).id || '');
  }
  return { ok: true };
}

function getMessages(sessionId, limit) {
  if (!init() || !sessionId) return [];
  const n = Math.max(1, Math.min(100, Number(limit) || 40));
  const rows = db.prepare('SELECT * FROM (SELECT * FROM chat_messages WHERE session_id=? ORDER BY id DESC LIMIT ?) ORDER BY id ASC')
    .all(String(sessionId), n);
  return rows.map(r => ({
    id: r.id, role: r.role, content: r.content, ts: r.ts,
    module: r.module || null, backend: r.backend || null
  }));
}

/** 清空某会话的消息（保留会话本身），同步维护 FTS */
function clearSession(sessionId) {
  if (!init() || !sessionId) return { ok: false, error: '缺少会话 id' };
  const sid = String(sessionId);
  try {
    db.exec('BEGIN');
    db.prepare('DELETE FROM chat_messages WHERE session_id=?').run(sid);
    db.prepare('UPDATE chat_sessions SET message_count=0, updated_at=? WHERE id=?').run(Date.now(), sid);
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) {}
    return { ok: false, error: e.message };
  }
  return { ok: true, session: getSession(sid) };
}

/** 追加一轮问答；首轮自动生成标题；返回会话摘要 */
function appendTurn(sessionId, turn) {
  if (!init()) return null;
  const sid = String(sessionId || '');
  let s = getSession(sid);
  if (!s) {
    s = createSession(String(turn && turn.question || '新会话').slice(0, 24) || '新会话');
    setMeta('currentSessionId', s.id);
  }
  const now = Date.now();
  const ins = db.prepare('INSERT INTO chat_messages(session_id,role,content,ts,module,backend) VALUES(?,?,?,?,?,?)');
  const items = [
    { role: 'user', content: turn.question, backend: null },
    { role: 'assistant', content: turn.answer, backend: turn.backend || null }
  ];
  try {
    db.exec('BEGIN');
    for (const m of items) {
      if (!m.content) continue;
      ins.run(s.id, m.role, String(m.content).slice(0, 8000), now, turn.module || '对话', m.backend);
    }
    const count = db.prepare('SELECT COUNT(*) AS n FROM chat_messages WHERE session_id=?').get(s.id).n;
    let title = s.title;
    if ((!title || title === '新会话') && turn.question) title = String(turn.question).replace(/\s+/g, ' ').slice(0, 24);
    db.prepare('UPDATE chat_sessions SET message_count=?, updated_at=?, title=? WHERE id=?').run(count, now, title, s.id);
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) {}
    return getSession(s.id);
  }
  return getSession(s.id);
}

/** 中文子串搜索：>=3 字走 FTS5 trigram，短词退回 LIKE */
function search(q, limit) {
  if (!init()) return [];
  const term = String(q || '').trim();
  if (!term) return [];
  const n = Math.max(1, Math.min(50, Number(limit) || 20));
  let rows;
  if (term.length >= 3) {
    rows = db.prepare(`
      SELECT m.id, m.session_id AS sessionId, s.title AS sessionTitle,
             m.role, m.content, m.ts
      FROM chat_messages_fts f
      JOIN chat_messages m ON m.id = f.rowid
      JOIN chat_sessions s ON s.id = m.session_id
      WHERE chat_messages_fts MATCH ?
      ORDER BY rank, m.ts DESC LIMIT ?
    `).all('"' + term.replace(/"/g, '""') + '"', n);
  } else {
    rows = db.prepare(`
      SELECT m.id, m.session_id AS sessionId, s.title AS sessionTitle,
             m.role, m.content, m.ts
      FROM chat_messages m JOIN chat_sessions s ON s.id = m.session_id
      WHERE m.content LIKE ? ORDER BY m.ts DESC LIMIT ?
    `).all('%' + term + '%', n);
  }
  return rows.map(x => ({ ...x, snippet: String(x.content).slice(0, 180) }));
}

function status() {
  if (!init()) return { ok: false, error: initError || 'init failed', dbPath: DB_PATH };
  return {
    ok: true, dbPath: DB_PATH,
    sessions: db.prepare('SELECT COUNT(*) AS n FROM chat_sessions').get().n,
    messages: db.prepare('SELECT COUNT(*) AS n FROM chat_messages').get().n,
    currentSessionId: getMeta('currentSessionId')
  };
}

module.exports = {
  status, listSessions, getSession, createSession, renameSession, deleteSession,
  getMessages, clearSession, appendTurn, search,
  getCurrentId: () => getMeta('currentSessionId'),
  setCurrentId: (id) => { setMeta('currentSessionId', id); return getSession(id); }
};
