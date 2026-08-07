'use strict';

/**
 * 免注册身份体系。
 *
 * 设计目标：用户不需要注册、不需要密码就能直接发言，但「身份必须统一」——
 *   1. 首次访问由服务端签发一个永久 uid，写进 HMAC 签名的 httpOnly Cookie，
 *      任何伪造/篡改都会验签失败，客户端无法冒充他人。
 *   2. 昵称全站唯一（忽略大小写与空白），并且展示时永远带上 #短号，
 *      同一个人在看板、帖子、聊天里都是同一个可辨识的身份。
 *   3. 换设备/清缓存不会丢身份：每个身份有一串「身份口令」，
 *      在新设备上粘贴即可找回同一个 uid（口令只存哈希）。
 */

const crypto = require('crypto');
const fs = require('fs');
const { SECRET_FILE, COOKIE_NAME, COOKIE_MAX_AGE, LIMITS, DATA_DIR } = require('./config');
const store = require('./store');

let SECRET = null;

function secret() {
  if (SECRET) return SECRET;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (process.env.DAZI_SECRET) {
    SECRET = process.env.DAZI_SECRET;
    return SECRET;
  }
  try {
    SECRET = fs.readFileSync(SECRET_FILE, 'utf8').trim();
    if (SECRET) return SECRET;
  } catch (_) {
    /* 首次启动，下面生成 */
  }
  SECRET = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(SECRET_FILE, SECRET, { mode: 0o600 });
  return SECRET;
}

const ADJECTIVES = [
  '爱睡觉的', '打球猛的', '不吃香菜的', '早八逃不掉的', '图书馆常驻的', '奶茶续命的',
  '夜跑的', '一到饭点就饿的', '选修课划水的', '宿舍最卷的', '拍照很稳的', '路痴的',
  '起床困难的', '球场蹲点的', '总在赶due的', '爱捡猫的', '会做饭的', '压马路的',
];
const CREATURES = [
  '柯基', '布偶猫', '水豚', '柴犬', '仓鼠', '海獭', '企鹅', '树懒', '橘猫', '兔子',
  '熊猫', '狐狸', '鲸鱼', '刺猬', '鹦鹉', '羊驼',
];
const EMOJIS = ['🏀', '🏸', '🎬', '🍜', '📚', '🎮', '🎤', '🚴', '🧋', '🐱', '🏓', '🎧', '🥾', '🎲'];
const COLORS = [
  '#ff8fab', '#ffb703', '#8ecae6', '#95d5b2', '#c8b6ff', '#ffd6a5',
  '#a0c4ff', '#fdffb6', '#bdb2ff', '#9bf6ff', '#caffbf', '#ffc6ff',
];

function pick(arr) {
  return arr[crypto.randomInt(arr.length)];
}

function shortId(uid) {
  return uid.slice(0, 4).toUpperCase();
}

/** 昵称归一化：用于全站唯一性判断，避免「小明」「小 明」「ＸＩＡＯ」混淆身份。 */
function normalizeNick(nick) {
  return String(nick).replace(/\s+/g, '').toLowerCase();
}

function nickTaken(nick, exceptUid) {
  const key = normalizeNick(nick);
  const users = store.data().users;
  for (const uid of Object.keys(users)) {
    if (uid === exceptUid) continue;
    if (normalizeNick(users[uid].nick) === key) return true;
  }
  return false;
}

function generateNick() {
  for (let i = 0; i < 40; i++) {
    const nick = `${pick(ADJECTIVES)}${pick(CREATURES)}`;
    if (nick.length <= LIMITS.nick && !nickTaken(nick)) return nick;
  }
  return `搭子${crypto.randomInt(100000, 999999)}`;
}

function makeRecoveryCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 16; i++) out += alphabet[crypto.randomInt(alphabet.length)];
  return `DAZI-${out.slice(0, 4)}-${out.slice(4, 8)}-${out.slice(8, 12)}-${out.slice(12)}`;
}

function hashRecovery(code) {
  return crypto
    .createHmac('sha256', secret())
    .update(String(code).trim().toUpperCase())
    .digest('hex');
}

function sign(uid) {
  const mac = crypto.createHmac('sha256', secret()).update(uid).digest('base64url');
  return `${uid}.${mac}`;
}

function verify(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const idx = token.lastIndexOf('.');
  const uid = token.slice(0, idx);
  const mac = token.slice(idx + 1);
  const expected = crypto.createHmac('sha256', secret()).update(uid).digest('base64url');
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return uid;
}

function parseCookies(req) {
  const header = req.headers.cookie;
  if (!header) return {};
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function createUser() {
  const uid = crypto.randomBytes(8).toString('hex');
  const code = makeRecoveryCode();
  const user = {
    uid,
    nick: generateNick(),
    emoji: pick(EMOJIS),
    color: pick(COLORS),
    createdAt: Date.now(),
    lastSeen: Date.now(),
    recoveryHash: hashRecovery(code),
    // 邮箱完全可选，只用于「有人认真看了你的帖子」提醒，绝不对外暴露
    email: '',
    notifyEmail: true,
  };
  const db = store.data();
  db.users[uid] = user;
  db.recovery[user.recoveryHash] = uid;
  store.save();
  // 明文口令只在创建这一刻返回一次，之后服务端只留哈希。
  return { user, recoveryCode: code };
}

function setIdentityCookie(res, uid, isSecure) {
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(sign(uid))}`,
    'Path=/',
    `Max-Age=${COOKIE_MAX_AGE}`,
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (isSecure) parts.push('Secure');
  const prev = res.getHeader('Set-Cookie');
  const list = prev ? (Array.isArray(prev) ? prev.slice() : [prev]) : [];
  list.push(parts.join('; '));
  res.setHeader('Set-Cookie', list);
}

function isSecureRequest(req) {
  const proto = req.headers['x-forwarded-proto'];
  if (proto) return String(proto).split(',')[0].trim() === 'https';
  return Boolean(req.socket && req.socket.encrypted);
}

/** 读取当前身份；没有就地签发一个新的（免注册的关键）。 */
function identify(req, res, { create = true } = {}) {
  const db = store.data();
  const token = parseCookies(req)[COOKIE_NAME];
  const uid = token ? verify(token) : null;
  if (uid && db.users[uid]) {
    db.users[uid].lastSeen = Date.now();
    store.save();
    return { user: db.users[uid], fresh: false, recoveryCode: null };
  }
  if (!create) return null;
  const { user, recoveryCode } = createUser();
  setIdentityCookie(res, user.uid, isSecureRequest(req));
  return { user, fresh: true, recoveryCode };
}

/** 用身份口令在新设备上恢复同一个身份。 */
function restore(req, res, code) {
  const db = store.data();
  const uid = db.recovery[hashRecovery(code)];
  if (!uid || !db.users[uid]) return null;
  setIdentityCookie(res, uid, isSecureRequest(req));
  db.users[uid].lastSeen = Date.now();
  store.save();
  return db.users[uid];
}

function rotateRecovery(uid) {
  const db = store.data();
  const user = db.users[uid];
  if (!user) return null;
  delete db.recovery[user.recoveryHash];
  const code = makeRecoveryCode();
  user.recoveryHash = hashRecovery(code);
  db.recovery[user.recoveryHash] = uid;
  store.save();
  return code;
}

/** 对外暴露的用户信息，绝不包含 recoveryHash 和邮箱。 */
function publicUser(user) {
  if (!user) {
    return { uid: null, nick: '已注销的搭子', emoji: '👤', color: '#cccccc', tag: '----' };
  }
  return {
    uid: user.uid,
    nick: user.nick,
    emoji: user.emoji,
    color: user.color,
    tag: shortId(user.uid),
    // 注册与管理员是公开事实（要在帖子里显示徽标），用户名和密码不是
    registered: Boolean(user.username),
    admin: user.role === 'admin',
  };
}

/** 只返回给本人的信息，比 publicUser 多了用户名、邮箱等私有字段。 */
function selfUser(user) {
  return {
    ...publicUser(user),
    username: user.username || '',
    email: user.email || '',
    notifyEmail: user.notifyEmail !== false,
    banned: Boolean(user.banned),
  };
}

module.exports = {
  identify,
  restore,
  createUser,
  setIdentityCookie,
  isSecureRequest,
  rotateRecovery,
  publicUser,
  selfUser,
  nickTaken,
  normalizeNick,
  shortId,
};
