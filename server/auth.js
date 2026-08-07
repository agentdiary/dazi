'use strict';

/**
 * 账号体系：注册 / 登录 / 管理员。
 *
 * 与匿名身份的关系：注册**不是**新建一个人，而是给当前这个匿名身份绑定
 * 用户名和密码。所以注册前发的帖子、说过的话、攒下的 #短号 全都继承过来，
 * 不会分裂成两个身份——这正是「统一性」的延续。
 *
 * 登录则是把当前浏览器的身份 Cookie 指向那个账号的 uid。
 *
 * 密码用 scrypt 加盐哈希（node:crypto 自带，维持零依赖），
 * 比对走 timingSafeEqual，避免时序侧信道。
 */

const crypto = require('crypto');
const { promisify } = require('util');
const store = require('./store');

const scrypt = promisify(crypto.scrypt);

const USERNAME_RE = /^[A-Za-z0-9_\-一-龥]{3,20}$/;
const PASSWORD_MIN = 6;
const PASSWORD_MAX = 128;

/* ------------------------------------------------------------ 密码 */

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

async function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false;
  const [algo, saltB64, keyB64] = stored.split('$');
  if (algo !== 'scrypt' || !saltB64 || !keyB64) return false;
  const expected = Buffer.from(keyB64, 'base64url');
  let actual;
  try {
    actual = await scrypt(password, Buffer.from(saltB64, 'base64url'), expected.length);
  } catch (_) {
    return false;
  }
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

/* ------------------------------------------------------------ 用户名 */

function normalizeUsername(username) {
  return String(username).trim().toLowerCase();
}

function findByUsername(username) {
  const key = normalizeUsername(username);
  const users = store.data().users;
  for (const uid of Object.keys(users)) {
    if (users[uid].username && normalizeUsername(users[uid].username) === key) return users[uid];
  }
  return null;
}

function validateCredentials(username, password) {
  const name = String(username || '').trim();
  if (!USERNAME_RE.test(name)) {
    return { error: '用户名需要 3-20 位，可用中英文、数字、下划线和连字符' };
  }
  const pw = String(password || '');
  if (pw.length < PASSWORD_MIN) return { error: `密码至少 ${PASSWORD_MIN} 位` };
  if (pw.length > PASSWORD_MAX) return { error: '密码太长了' };
  return { name, password: pw };
}

/* ------------------------------------------------------------ 注册与登录 */

/** 给当前匿名身份绑定账号。原有的帖子、发言、昵称一并保留。 */
async function register(user, username, password) {
  if (user.username) return { error: '这个身份已经注册过账号了' };
  const checked = validateCredentials(username, password);
  if (checked.error) return checked;
  if (findByUsername(checked.name)) return { error: '这个用户名已经被占用了' };

  user.username = checked.name;
  user.passwordHash = await hashPassword(checked.password);
  user.role = user.role || 'user';
  user.registeredAt = Date.now();
  store.save();
  return { user };
}

async function login(username, password) {
  const target = findByUsername(username);
  // 用户名不存在时也走一次哈希，避免用响应快慢反推用户名是否存在
  const stored = target ? target.passwordHash : 'scrypt$AAAA$AAAA';
  const okPassword = await verifyPassword(String(password || ''), stored);
  if (!target || !okPassword) return { error: '用户名或密码不对' };
  if (target.banned) return { error: '这个账号已被管理员封禁' };
  return { user: target };
}

async function changePassword(user, oldPassword, newPassword) {
  if (!user.username) return { error: '当前身份还没有注册账号' };
  if (!(await verifyPassword(String(oldPassword || ''), user.passwordHash))) {
    return { error: '原密码不对' };
  }
  const checked = validateCredentials(user.username, newPassword);
  if (checked.error) return checked;
  user.passwordHash = await hashPassword(checked.password);
  store.save();
  return { user };
}

/* ------------------------------------------------------------ 管理员 */

const isAdmin = (user) => Boolean(user && user.role === 'admin');

/**
 * 启动时按环境变量准备管理员账号：
 *   DAZI_ADMIN_USER / DAZI_ADMIN_PASS
 * 账号不存在就创建，已存在就提升为管理员并重设密码（忘了密码时的找回手段）。
 */
async function bootstrapAdmin() {
  const username = process.env.DAZI_ADMIN_USER;
  const password = process.env.DAZI_ADMIN_PASS;
  if (!username || !password) return null;

  const checked = validateCredentials(username, password);
  if (checked.error) {
    console.error(`[auth] 管理员账号未创建：${checked.error}`);
    return null;
  }

  const db = store.data();
  let user = findByUsername(checked.name);

  if (!user) {
    // 复用 identity 的建号逻辑，管理员也是一个普通身份 + 一个 role
    const identity = require('./identity');
    const created = identity.createUser();
    user = created.user;
    user.nick = `管理员${String(user.uid).slice(0, 4).toUpperCase()}`;
    user.username = checked.name;
    user.emoji = '🛡️';
    console.log(`[auth] 已创建管理员账号：${checked.name}`);
  } else {
    console.log(`[auth] 已将 ${checked.name} 设为管理员并重设密码`);
  }

  user.role = 'admin';
  user.banned = false;
  user.passwordHash = await hashPassword(checked.password);
  user.registeredAt = user.registeredAt || Date.now();
  db.users[user.uid] = user;
  store.save();
  return user;
}

/* ------------------------------------------------------------ 站点统计 */

function overview() {
  const db = store.data();
  const users = Object.values(db.users);
  const posts = Object.values(db.posts);
  return {
    users: users.length,
    registered: users.filter((u) => u.username).length,
    banned: users.filter((u) => u.banned).length,
    posts: posts.length,
    locked: posts.filter((p) => p.locked).length,
    done: posts.filter((p) => p.status === 'done').length,
    messages: posts.reduce((sum, p) => sum + p.messages.length, 0),
  };
}

module.exports = {
  register,
  login,
  changePassword,
  findByUsername,
  normalizeUsername,
  validateCredentials,
  hashPassword,
  verifyPassword,
  isAdmin,
  bootstrapAdmin,
  overview,
  USERNAME_RE,
  PASSWORD_MIN,
};
