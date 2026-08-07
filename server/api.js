'use strict';

const store = require('./store');
const identity = require('./identity');
const rt = require('./realtime');
const P = require('./posts');
const presence = require('./presence');
const notify = require('./notify');
const mailer = require('./mailer');
const auth = require('./auth');
const { LIMITS, REQUIRE_LOGIN } = require('./config');

/* ---------------------------------------------------------------- 基础工具 */

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

const ok = (res, body) => json(res, 200, body);
const fail = (res, status, message) => json(res, status, { error: message });

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (_) {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

/* ------------------------------------------------------------ 简易限流 */

const buckets = new Map();

function rateLimit(key, max, windowMs) {
  const now = Date.now();
  const hits = (buckets.get(key) || []).filter((t) => now - t < windowMs);
  if (hits.length >= max) {
    buckets.set(key, hits);
    return false;
  }
  hits.push(now);
  buckets.set(key, hits);
  return true;
}

setInterval(() => {
  const now = Date.now();
  for (const [key, hits] of buckets) {
    const kept = hits.filter((t) => now - t < 3600_000);
    if (kept.length) buckets.set(key, kept);
    else buckets.delete(key);
  }
}, 600_000).unref();

/* --------------------------------------------------------- 写权限守卫 */

/**
 * 所有「写」操作的统一入口检查：封禁优先于一切，其次是强制登录开关。
 * 返回 true 表示已经写过响应，调用方应立即 return。
 */
function blockedFromWriting(res, user) {
  if (user.banned) {
    fail(res, 403, '你的账号已被管理员封禁，无法发帖或发言');
    return true;
  }
  if (REQUIRE_LOGIN && !user.username) {
    fail(res, 401, '本站已开启「登录后才能发言」，请先注册或登录');
    return true;
  }
  return false;
}

/* ------------------------------------------------------------ 广播助手 */

function broadcastCard(post) {
  // 看板频道是公共的，只广播「有变化」信号 + 公共字段，
  // 每个浏览器自己带 cookie 去拉自己视角的数据，避免泄露锁帖内容。
  rt.publish(rt.boardChannel(), 'board:update', { postId: post.id, state: P.stateOf(post) });
}

function broadcastPost(post, event, payload) {
  rt.publish(rt.postChannel(post.id), event, payload);
}

/* ---------------------------------------------------------------- 路由 */

async function handle(req, res, url) {
  const path = url.pathname;
  const method = req.method;

  /* --- 元信息：分类 / 泳道 / 预设项目 --- */
  if (path === '/api/meta' && method === 'GET') {
    return ok(res, {
      categories: P.CATEGORIES,
      states: P.STATES,
      sorts: P.SORTS,
      presetOptions: P.PRESET_OPTIONS,
      limits: LIMITS,
      mailEnabled: mailer.enabled(),
      requireLogin: REQUIRE_LOGIN,
      usernameRule: { min: 3, max: 20, passwordMin: auth.PASSWORD_MIN },
      notifyRule: {
        dwellMinutes: Math.round(notify.DWELL_THRESHOLD_MS / 60000),
        minMessages: notify.MIN_MESSAGES,
      },
    });
  }

  /* --- 身份 --- */

  if (path === '/api/me' && method === 'GET') {
    const me = identity.identify(req, res);
    presence.markSeen(me.user.uid);
    return ok(res, {
      user: identity.selfUser(me.user),
      fresh: me.fresh,
      recoveryCode: me.recoveryCode, // 仅首次签发时返回一次
      onlineNow: presence.onlineCount(),
    });
  }

  if (path === '/api/me' && method === 'PATCH') {
    const me = identity.identify(req, res);
    const body = await readBody(req);
    const db = store.data();
    const user = db.users[me.user.uid];

    if (typeof body.nick === 'string') {
      const nick = P.clampText(body.nick, LIMITS.nick);
      if (!nick) return fail(res, 400, '昵称不能为空');
      if (identity.nickTaken(nick, user.uid)) {
        return fail(res, 409, '这个昵称已经被别的同学用了，换一个吧');
      }
      user.nick = nick;
    }
    if (typeof body.emoji === 'string' && body.emoji.trim()) {
      user.emoji = Array.from(body.emoji.trim())[0];
    }
    if (typeof body.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(body.color.trim())) {
      user.color = body.color.trim();
    }
    if (typeof body.email === 'string') {
      const email = body.email.trim();
      if (email && !mailer.isValidAddress(email)) return fail(res, 400, '邮箱格式不太对');
      user.email = email;
    }
    if (body.notifyEmail !== undefined) user.notifyEmail = Boolean(body.notifyEmail);
    store.save();
    // 昵称/头像变了，看板与聊天里的历史署名也要跟着变（身份统一）。
    rt.publish(rt.boardChannel(), 'user:update', { uid: user.uid });
    return ok(res, { user: identity.selfUser(user) });
  }

  /* --- 注册 / 登录 --- */

  if (path === '/api/auth/register' && method === 'POST') {
    const me = identity.identify(req, res);
    if (!rateLimit(`register:${me.user.uid}`, 5, 3600_000)) {
      return fail(res, 429, '尝试太频繁了，过会儿再试');
    }
    const body = await readBody(req);
    // 注册是把账号绑到当前这个匿名身份上，原有帖子和发言都跟着走
    const result = await auth.register(me.user, body.username, body.password);
    if (result.error) return fail(res, 400, result.error);
    rt.publish(rt.boardChannel(), 'user:update', { uid: me.user.uid });
    return ok(res, { user: identity.selfUser(result.user) });
  }

  if (path === '/api/auth/login' && method === 'POST') {
    const body = await readBody(req);
    const key = auth.normalizeUsername(body.username || '');
    if (!rateLimit(`login:${key}`, 10, 600_000)) {
      return fail(res, 429, '登录尝试过多，请十分钟后再试');
    }
    const result = await auth.login(body.username, body.password);
    if (result.error) return fail(res, 401, result.error);
    // 登录 = 把这个浏览器的身份 Cookie 指向该账号
    identity.setIdentityCookie(res, result.user.uid, identity.isSecureRequest(req));
    result.user.lastSeen = Date.now();
    store.save();
    return ok(res, { user: identity.selfUser(result.user) });
  }

  if (path === '/api/auth/logout' && method === 'POST') {
    // 退出后回到一个全新的匿名身份，这样还能继续浏览和（未开强制登录时）发言
    const { user } = identity.createUser();
    identity.setIdentityCookie(res, user.uid, identity.isSecureRequest(req));
    return ok(res, { user: identity.selfUser(user) });
  }

  if (path === '/api/auth/password' && method === 'POST') {
    const me = identity.identify(req, res);
    const body = await readBody(req);
    const result = await auth.changePassword(me.user, body.oldPassword, body.newPassword);
    if (result.error) return fail(res, 400, result.error);
    return ok(res, { user: identity.selfUser(result.user) });
  }

  /* --- 管理员 --- */

  if (path.startsWith('/api/admin/')) {
    const me = identity.identify(req, res);
    if (!auth.isAdmin(me.user)) return fail(res, 403, '需要管理员权限');
    return handleAdmin(req, res, url, path, method, me.user);
  }

  if (path === '/api/me/recovery' && method === 'POST') {
    const me = identity.identify(req, res);
    const code = identity.rotateRecovery(me.user.uid);
    return ok(res, { recoveryCode: code });
  }

  if (path === '/api/session/restore' && method === 'POST') {
    const body = await readBody(req);
    const user = identity.restore(req, res, String(body.code || ''));
    if (!user) return fail(res, 404, '身份口令无效，请检查后重试');
    return ok(res, { user: identity.publicUser(user) });
  }

  /* --- 看板 --- */

  if (path === '/api/posts' && method === 'GET') {
    const me = identity.identify(req, res);
    const uid = me.user.uid;
    presence.markSeen(uid);
    const db = store.data();
    const category = url.searchParams.get('category') || '';
    const q = (url.searchParams.get('q') || '').trim().toLowerCase();
    const mine = url.searchParams.get('mine') === '1';
    const stateFilter = url.searchParams.get('state') || '';
    const sort = P.SORTS.some((s) => s.id === url.searchParams.get('sort'))
      ? url.searchParams.get('sort')
      : 'active';

    // 先序列化再排序：空位、人气这些排序键都在卡片视图上，避免重复计算。
    const cards = Object.values(db.posts)
      .filter((post) => (category ? post.category === category : true))
      .filter((post) => (mine ? P.isHost(post, uid) || P.isMember(post, uid) : true))
      .filter((post) => {
        if (!q) return true;
        const haystack = [post.title, post.campus, post.timeText, ...post.options.map((o) => o.label)]
          .join(' ')
          .toLowerCase();
        return haystack.includes(q);
      })
      .map((post) => P.serializeCard(post, uid))
      .filter((card) => (stateFilter ? card.state === stateFilter : true))
      .sort(P.comparator(sort));

    // 各状态各有多少条，用于筛选面板上显示数量
    const counts = { all: 0 };
    for (const post of Object.values(db.posts)) {
      const state = P.stateOf(post);
      counts[state] = (counts[state] || 0) + 1;
      counts.all += 1;
    }

    return ok(res, {
      cards,
      counts,
      sort,
      me: identity.publicUser(me.user),
      onlineNow: presence.onlineCount(),
    });
  }

  if (path === '/api/posts' && method === 'POST') {
    const me = identity.identify(req, res);
    const uid = me.user.uid;
    if (blockedFromWriting(res, me.user)) return;
    if (!rateLimit(`post:${uid}`, LIMITS.postsPerUserPerHour, 3600_000)) {
      return fail(res, 429, '发帖太频繁啦，休息一下再来');
    }
    const body = await readBody(req);

    const title = P.clampText(body.title, LIMITS.title);
    if (!title) return fail(res, 400, '给你的搭子局起个标题吧');

    const rawOptions = Array.isArray(body.options) ? body.options : [];
    const options = [];
    const seen = new Set();
    for (const item of rawOptions) {
      const label = P.clampText(item && item.label, LIMITS.optionLabel);
      if (!label || seen.has(label)) continue;
      seen.add(label);
      const emoji = typeof item.emoji === 'string' && item.emoji.trim()
        ? Array.from(item.emoji.trim())[0]
        : '•';
      options.push({ id: P.newId(), label, emoji });
      if (options.length >= LIMITS.optionsPerPost) break;
    }
    if (options.length === 0) return fail(res, 400, '至少选一个想一起做的项目');

    const category = P.CATEGORIES.some((c) => c.id === body.category) ? body.category : 'other';
    const capacity = Math.min(
      Math.max(parseInt(body.capacity, 10) || 4, 2),
      LIMITS.capacity,
    );

    const now = Date.now();
    const post = {
      id: P.newId(),
      hostId: uid,
      title,
      desc: P.clampText(body.desc, LIMITS.desc),
      category,
      campus: P.clampText(body.campus, LIMITS.place),
      place: P.clampText(body.place, LIMITS.place),
      timeText: P.clampText(body.timeText, LIMITS.timeText),
      capacity,
      options,
      locked: false,
      lockCodeHash: null,
      status: 'open',
      members: {},
      messages: [],
      createdAt: now,
      updatedAt: now,
    };
    // 发起人默认占一个名额，并落到自己勾的第一个项目上。
    post.members[uid] = { optionId: options[0].id, joinedAt: now };
    P.systemMessage(post, `${me.user.nick} 发起了这个搭子局，快来聊聊细节吧～`);

    store.data().posts[post.id] = post;
    store.save();
    rt.publish(rt.boardChannel(), 'board:new', { postId: post.id });
    return json(res, 201, { post: P.serializeDetail(post, uid) });
  }

  /* --- 实时流（要放在通用帖子路由之前） --- */

  if (path === '/api/stream' && method === 'GET') {
    const me = identity.identify(req, res);
    const uid = me.user.uid;
    presence.connect(uid);
    res.on('close', () => {
      presence.disconnect(uid);
      // 谁上下线会影响所有卡片上的在线人数，广播一下让大家刷新
      rt.publish(rt.boardChannel(), 'presence', { uid, online: presence.isOnline(uid) });
    });
    rt.publish(rt.boardChannel(), 'presence', { uid, online: true });
    return rt.openStream(req, res, rt.boardChannel());
  }

  const streamMatch = path.match(/^\/api\/posts\/([a-f0-9]{6,32})\/stream$/);
  if (streamMatch && method === 'GET') {
    const me = identity.identify(req, res);
    const uid = me.user.uid;
    const post = store.data().posts[streamMatch[1]];
    if (!post) return fail(res, 404, '帖子不存在');
    if (!P.canEnter(post, uid)) return fail(res, 403, '该帖子已被发起人锁定');

    presence.connect(uid);
    presence.enterRoom(post.id, uid);
    broadcastPost(post, 'presence', { uid, inRoom: true });
    res.on('close', () => {
      presence.disconnect(uid);
      presence.leaveRoom(post.id, uid);
      // 离开房间时结算这一段停留，可能刚好满足提醒条件
      notify.checkPost(post);
      broadcastPost(post, 'presence', { uid, inRoom: false });
    });
    return rt.openStream(req, res, rt.postChannel(post.id));
  }

  /* --- 单个帖子 --- */

  const postMatch = path.match(/^\/api\/posts\/([a-f0-9]{6,32})(\/[a-z]+)?$/);
  if (postMatch) {
    const post = store.data().posts[postMatch[1]];
    const action = postMatch[2] || '';
    if (!post) return fail(res, 404, '这个帖子不存在或已被删除');
    return handlePost(req, res, url, post, action, method);
  }

  return fail(res, 404, '接口不存在');
}

/* ------------------------------------------------------------ 管理后台 */

async function handleAdmin(req, res, url, path, method, admin) {
  const db = store.data();

  if (path === '/api/admin/overview' && method === 'GET') {
    return ok(res, {
      stats: { ...auth.overview(), online: presence.onlineCount() },
      mailEnabled: mailer.enabled(),
      requireLogin: REQUIRE_LOGIN,
      usernameRule: { min: 3, max: 20, passwordMin: auth.PASSWORD_MIN },
      requireLogin: REQUIRE_LOGIN,
    });
  }

  if (path === '/api/admin/users' && method === 'GET') {
    const q = (url.searchParams.get('q') || '').trim().toLowerCase();
    const users = Object.values(db.users)
      .filter((u) => {
        if (!q) return true;
        return `${u.nick} ${u.username || ''} ${u.uid}`.toLowerCase().includes(q);
      })
      .sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0))
      .slice(0, 200)
      .map((u) => ({
        ...identity.publicUser(u),
        username: u.username || '',
        banned: Boolean(u.banned),
        createdAt: u.createdAt,
        lastSeen: u.lastSeen,
        online: presence.isOnline(u.uid),
        posts: Object.values(db.posts).filter((p) => p.hostId === u.uid).length,
      }));
    return ok(res, { users });
  }

  const userMatch = path.match(/^\/api\/admin\/users\/([a-f0-9]{4,32})\/(ban|role)$/);
  if (userMatch && method === 'POST') {
    const target = db.users[userMatch[1]];
    if (!target) return fail(res, 404, '找不到这个用户');
    if (target.uid === admin.uid) return fail(res, 400, '不能对自己执行这个操作');
    const body = await readBody(req);

    if (userMatch[2] === 'ban') {
      target.banned = Boolean(body.banned);
    } else {
      const role = body.role === 'admin' ? 'admin' : 'user';
      if (role === 'user' && target.role === 'admin') {
        // 别把最后一个管理员降权，否则后台就再也进不去了
        const admins = Object.values(db.users).filter((u) => u.role === 'admin');
        if (admins.length <= 1) return fail(res, 400, '至少要保留一个管理员');
      }
      target.role = role;
    }
    store.save();
    rt.publish(rt.boardChannel(), 'user:update', { uid: target.uid });
    return ok(res, { user: identity.publicUser(target), banned: Boolean(target.banned) });
  }

  if (path === '/api/admin/posts' && method === 'GET') {
    const posts = Object.values(db.posts)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 200)
      .map((post) => ({
        id: post.id,
        title: post.title,
        state: P.stateOf(post),
        locked: post.locked,
        host: identity.publicUser(db.users[post.hostId]),
        memberCount: P.memberCount(post),
        messageCount: post.messages.length,
        createdAt: post.createdAt,
        updatedAt: post.updatedAt,
      }));
    return ok(res, { posts });
  }

  const msgMatch = path.match(/^\/api\/admin\/posts\/([a-f0-9]{6,32})\/messages\/([a-f0-9]{6,32})$/);
  if (msgMatch && method === 'DELETE') {
    const post = db.posts[msgMatch[1]];
    if (!post) return fail(res, 404, '帖子不存在');
    const index = post.messages.findIndex((m) => m.id === msgMatch[2]);
    if (index < 0) return fail(res, 404, '消息不存在');
    post.messages.splice(index, 1);
    P.systemMessage(post, '一条消息被管理员删除了');
    post.updatedAt = Date.now();
    store.save();
    broadcastPost(post, 'post:update', { postId: post.id });
    return ok(res, { deleted: true });
  }

  return fail(res, 404, '接口不存在');
}

/* --------------------------------------------------- 单帖子的各类操作 */

async function handlePost(req, res, url, post, action, method) {
  const me = identity.identify(req, res);
  const uid = me.user.uid;
  const db = store.data();

  /* 详情 */
  if (action === '' && method === 'GET') {
    return ok(res, { post: P.serializeDetail(post, uid) });
  }

  /* 发起人编辑：改信息 / 锁帖 / 完成 */
  if (action === '' && method === 'PATCH') {
    if (!P.isHost(post, uid) && !auth.isAdmin(me.user)) {
      return fail(res, 403, '只有发起人可以修改这个帖子');
    }
    const body = await readBody(req);

    if (typeof body.title === 'string') {
      const title = P.clampText(body.title, LIMITS.title);
      if (title) post.title = title;
    }
    if (typeof body.desc === 'string') post.desc = P.clampText(body.desc, LIMITS.desc);
    if (typeof body.place === 'string') post.place = P.clampText(body.place, LIMITS.place);
    if (typeof body.timeText === 'string') post.timeText = P.clampText(body.timeText, LIMITS.timeText);
    if (body.capacity !== undefined) {
      const capacity = Math.min(Math.max(parseInt(body.capacity, 10) || post.capacity, 2), LIMITS.capacity);
      post.capacity = Math.max(capacity, P.memberCount(post));
    }
    if (body.status === 'open' || body.status === 'done') {
      if (post.status !== body.status) {
        post.status = body.status;
        P.systemMessage(post, body.status === 'done' ? '发起人把这个局标记为「已完成」🎉' : '发起人重新开放了这个局');
      }
    }

    /* 锁帖：核心功能 —— 锁上之后别人进不来 */
    if (body.locked !== undefined) {
      const locked = Boolean(body.locked);
      if (locked !== post.locked) {
        post.locked = locked;
        if (locked) {
          const code = P.clampText(body.lockCode, 24);
          post.lockCodeHash = code ? P.hashCode(code) : null;
          P.systemMessage(post, code
            ? '发起人锁定了这个帖子，只有知道暗号的人才能进来 🔒'
            : '发起人锁定了这个帖子，现在只有已加入的成员能进来 🔒');
          // 把正在围观但没加入的人从帖子频道踢出去
          rt.publish(rt.postChannel(post.id), 'post:locked', { postId: post.id });
        } else {
          post.lockCodeHash = null;
          P.systemMessage(post, '发起人解锁了这个帖子，大家都可以进来了 🔓');
        }
      } else if (locked && body.lockCode !== undefined) {
        const code = P.clampText(body.lockCode, 24);
        post.lockCodeHash = code ? P.hashCode(code) : null;
      }
    }

    post.updatedAt = Date.now();
    store.save();
    broadcastCard(post);
    broadcastPost(post, 'post:update', { postId: post.id });
    return ok(res, { post: P.serializeDetail(post, uid) });
  }

  /* 删除 */
  if (action === '' && method === 'DELETE') {
    if (!P.isHost(post, uid) && !auth.isAdmin(me.user)) {
      return fail(res, 403, '只有发起人可以删除这个帖子');
    }
    delete db.posts[post.id];
    store.save();
    rt.publish(rt.boardChannel(), 'board:remove', { postId: post.id });
    rt.closeChannel(rt.postChannel(post.id), 'post:removed', { postId: post.id });
    return ok(res, { deleted: true });
  }

  /* 报名加入（并选择自己想参加的项目） */
  if (action === '/join' && method === 'POST') {
    if (blockedFromWriting(res, me.user)) return;
    const body = await readBody(req);
    if (P.isMember(post, uid)) return ok(res, { post: P.serializeDetail(post, uid) });
    if (post.status === 'done') return fail(res, 409, '这个局已经结束啦');

    if (post.locked) {
      const code = P.clampText(body.code, 24);
      if (!post.lockCodeHash || !code || P.hashCode(code) !== post.lockCodeHash) {
        return fail(res, 403, '帖子已被锁定，进不去哦');
      }
    }
    if (P.memberCount(post) >= post.capacity) return fail(res, 409, '人数已满，来晚一步');

    const optionId = post.options.some((o) => o.id === body.optionId)
      ? body.optionId
      : post.options[0].id;
    post.members[uid] = { optionId, joinedAt: Date.now() };
    const option = post.options.find((o) => o.id === optionId);
    P.systemMessage(post, `${me.user.nick} 加入了，想一起「${option.label}」`);
    post.updatedAt = Date.now();
    store.save();
    broadcastCard(post);
    broadcastPost(post, 'post:update', { postId: post.id });
    return ok(res, { post: P.serializeDetail(post, uid) });
  }

  /* 退出 */
  if (action === '/leave' && method === 'POST') {
    if (P.isHost(post, uid)) return fail(res, 400, '发起人不能退出，可以直接删除或标记完成');
    if (!P.isMember(post, uid)) return fail(res, 400, '你还没有加入这个局');
    delete post.members[uid];
    P.systemMessage(post, `${me.user.nick} 退出了这个局`);
    post.updatedAt = Date.now();
    store.save();
    broadcastCard(post);
    broadcastPost(post, 'post:update', { postId: post.id });
    return ok(res, { post: P.serializeDetail(post, uid) });
  }

  /* 改投别的项目 */
  if (action === '/vote' && method === 'POST') {
    if (blockedFromWriting(res, me.user)) return;
    const body = await readBody(req);
    if (!P.isMember(post, uid)) return fail(res, 403, '先加入这个局才能选项目');
    if (!post.options.some((o) => o.id === body.optionId)) return fail(res, 400, '没有这个选项');
    post.members[uid].optionId = body.optionId;
    post.updatedAt = Date.now();
    store.save();
    broadcastCard(post);
    broadcastPost(post, 'post:update', { postId: post.id });
    return ok(res, { post: P.serializeDetail(post, uid) });
  }

  /* 帖子内聊天 */
  if (action === '/messages' && method === 'POST') {
    if (blockedFromWriting(res, me.user)) return;
    if (!P.canEnter(post, uid)) return fail(res, 403, '帖子已被锁定，你现在进不去');
    if (post.status === 'done' && !P.isMember(post, uid)) return fail(res, 409, '这个局已经结束了');
    if (!rateLimit(`msg:${uid}`, LIMITS.messagesPerMinute, 60_000)) {
      return fail(res, 429, '说得太快啦，缓一缓');
    }
    const body = await readBody(req);
    const text = typeof body.text === 'string' ? body.text.trim().slice(0, LIMITS.message) : '';
    if (!text) return fail(res, 400, '说点什么吧');

    const msg = { id: P.newId(), uid, text, ts: Date.now(), kind: 'msg' };
    post.messages.push(msg);
    P.trimMessages(post);
    post.updatedAt = Date.now();
    // 记一笔发言，并结算到此刻的停留时长——发言后可能刚好够到提醒条件
    presence.accrue(post.id, uid);
    presence.countMessage(post, uid);
    notify.checkPost(post);
    store.save();
    broadcastPost(post, 'message', { postId: post.id, message: P.serializeMessage(msg) });
    rt.publish(rt.boardChannel(), 'board:update', { postId: post.id, state: P.stateOf(post) });
    return json(res, 201, { message: P.serializeMessage(msg) });
  }

  /* 发起人移出成员 */
  if (action === '/kick' && method === 'POST') {
    if (!P.isHost(post, uid) && !auth.isAdmin(me.user)) {
      return fail(res, 403, '只有发起人可以移出成员');
    }
    const body = await readBody(req);
    const target = String(body.uid || '');
    if (!P.isMember(post, target) || target === uid) return fail(res, 400, '找不到这个成员');
    const targetUser = db.users[target];
    delete post.members[target];
    P.systemMessage(post, `${targetUser ? targetUser.nick : '某位同学'} 被发起人移出了这个局`);
    post.updatedAt = Date.now();
    store.save();
    broadcastCard(post);
    broadcastPost(post, 'post:update', { postId: post.id });
    return ok(res, { post: P.serializeDetail(post, uid) });
  }

  return fail(res, 405, '不支持的操作');
}

module.exports = { handle, json, fail };
