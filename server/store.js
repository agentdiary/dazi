'use strict';

/**
 * 极简持久化：内存对象 + 防抖落盘（原子写）。
 * 站点数据量小（校园范围的帖子与聊天），不引入任何 npm 依赖，
 * 部署时无需编译原生模块，最大化环境兼容性。
 */

const fs = require('fs');
const path = require('path');
const { DATA_DIR, DB_FILE } = require('./config');

const EMPTY = { users: {}, posts: {}, recovery: {}, meta: { version: 1 } };

let db = null;
let flushTimer = null;
let flushing = false;
let dirtyWhileFlushing = false;

function load() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  try {
    const raw = fs.readFileSync(DB_FILE, 'utf8');
    db = Object.assign({}, EMPTY, JSON.parse(raw));
    for (const key of Object.keys(EMPTY)) {
      if (!db[key]) db[key] = JSON.parse(JSON.stringify(EMPTY[key]));
    }
  } catch (err) {
    if (err.code !== 'ENOENT') {
      // 数据文件损坏时不静默丢数据：备份后重新开始。
      const backup = `${DB_FILE}.corrupt-${Date.now()}`;
      try {
        fs.copyFileSync(DB_FILE, backup);
        console.error(`[store] 数据文件解析失败，已备份到 ${backup}`);
      } catch (_) {
        console.error('[store] 数据文件解析失败且备份失败', err);
      }
    }
    db = JSON.parse(JSON.stringify(EMPTY));
  }
  return db;
}

function data() {
  if (!db) load();
  return db;
}

function writeNow() {
  const tmp = path.join(DATA_DIR, `.dazi.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(db), 'utf8');
  fs.renameSync(tmp, DB_FILE);
}

function flush() {
  if (flushing) {
    dirtyWhileFlushing = true;
    return;
  }
  flushing = true;
  try {
    writeNow();
  } catch (err) {
    console.error('[store] 落盘失败', err);
  } finally {
    flushing = false;
    if (dirtyWhileFlushing) {
      dirtyWhileFlushing = false;
      save();
    }
  }
}

/** 标记数据已变更，200ms 内合并写入一次。 */
function save() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flush();
  }, 200);
  if (flushTimer.unref) flushTimer.unref();
}

/** 进程退出前同步落盘。 */
function saveSync() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  try {
    writeNow();
  } catch (err) {
    console.error('[store] 退出前落盘失败', err);
  }
}

module.exports = { load, data, save, saveSync };
