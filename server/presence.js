'use strict';

/**
 * 在线状态与「在帖子里待了多久」的统计。
 *
 * 在线判定直接复用 SSE 长连接：连接开着就是在线，断开后留 45 秒宽限
 * （刷新页面、切网络会短暂断流，不该立刻显示成离线）。
 *
 * 停留时长不能只记「进入时间」——用户可能挂着页面一整天，也可能反复刷新。
 * 这里用「打点累加」：每 30 秒把还开着的连接的这一段时间累加进去，
 * 断开时补上最后一段。累计值写进帖子的 visits 里持久化，重启不清零。
 */

const store = require('./store');

const TICK_MS = 30_000;
const OFFLINE_GRACE_MS = 45_000;

const connections = new Map(); // uid -> 连接数
const lastSeen = new Map();    // uid -> 最后一次有连接的时间
const rooms = new Map();       // postId -> Map<uid, { lastTickAt }>

function markSeen(uid) {
  if (uid) lastSeen.set(uid, Date.now());
}

function connect(uid) {
  if (!uid) return;
  connections.set(uid, (connections.get(uid) || 0) + 1);
  markSeen(uid);
}

function disconnect(uid) {
  if (!uid) return;
  const next = (connections.get(uid) || 1) - 1;
  if (next <= 0) connections.delete(uid);
  else connections.set(uid, next);
  markSeen(uid);
}

function isOnline(uid) {
  if (!uid) return false;
  if (connections.get(uid) > 0) return true;
  const seen = lastSeen.get(uid);
  return Boolean(seen && Date.now() - seen < OFFLINE_GRACE_MS);
}

function onlineCount() {
  let count = 0;
  for (const uid of new Set([...connections.keys(), ...lastSeen.keys()])) {
    if (isOnline(uid)) count += 1;
  }
  return count;
}

/* --------------------------------------------------------- 帖子内的停留 */

function visitOf(post, uid) {
  if (!post.visits) post.visits = {};
  if (!post.visits[uid]) {
    post.visits[uid] = { dwellMs: 0, messages: 0, notified: false, firstAt: Date.now(), lastAt: Date.now() };
  }
  return post.visits[uid];
}

/** 把某个人在某个帖子里「这一段」在线时间累加进去。 */
function accrue(postId, uid, now = Date.now()) {
  const room = rooms.get(postId);
  const entry = room && room.get(uid);
  if (!entry) return;
  const post = store.data().posts[postId];
  if (!post) return;
  const delta = now - entry.lastTickAt;
  entry.lastTickAt = now;
  // 单次累加超过 2 个打点周期，说明中间进程卡过/休眠过，按一个周期封顶，避免虚高
  if (delta <= 0) return;
  const visit = visitOf(post, uid);
  visit.dwellMs += Math.min(delta, TICK_MS * 2);
  visit.lastAt = now;
}

function enterRoom(postId, uid) {
  if (!uid) return;
  let room = rooms.get(postId);
  if (!room) {
    room = new Map();
    rooms.set(postId, room);
  }
  if (!room.has(uid)) room.set(uid, { lastTickAt: Date.now() });
  const post = store.data().posts[postId];
  if (post) {
    visitOf(post, uid).lastAt = Date.now();
    store.save();
  }
}

function leaveRoom(postId, uid) {
  if (!uid) return;
  accrue(postId, uid);
  const room = rooms.get(postId);
  if (!room) return;
  room.delete(uid);
  if (room.size === 0) rooms.delete(postId);
  store.save();
}

function countMessage(post, uid) {
  const visit = visitOf(post, uid);
  visit.messages += 1;
  visit.lastAt = Date.now();
}

/** 谁正在这个帖子的房间里。 */
function whoIsInRoom(postId) {
  const room = rooms.get(postId);
  if (!room) return [];
  return [...room.keys()].filter((uid) => isOnline(uid));
}

/** 定时打点：累加所有房间的在线时长，然后交给回调去判断要不要发提醒。 */
function startTicking(onTick) {
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [postId, room] of rooms) {
      for (const uid of room.keys()) accrue(postId, uid, now);
    }
    store.save();
    if (onTick) {
      try {
        onTick();
      } catch (err) {
        console.error('[presence] tick 回调出错', err);
      }
    }
  }, TICK_MS);
  timer.unref();
  return timer;
}

module.exports = {
  connect,
  disconnect,
  markSeen,
  isOnline,
  onlineCount,
  enterRoom,
  leaveRoom,
  accrue,
  countMessage,
  visitOf,
  whoIsInRoom,
  startTicking,
  TICK_MS,
};
