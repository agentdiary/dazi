'use strict';

/**
 * 端到端冒烟测试：不依赖任何测试框架，直接起服务打真实 HTTP。
 *   node test/smoke.js
 * 覆盖：免注册身份签发与统一性、发帖、多选项投票、锁帖拦截、暗号进入、帖子内聊天、SSE 推送。
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');

const PORT = 8791;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dazi-smoke-'));

let passed = 0;
const failures = [];

function check(name, condition, extra = '') {
  if (condition) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(`${name} ${extra}`);
    console.log(`  ✗ ${name} ${extra}`);
  }
}

/** 每个 client 有自己的 cookie 罐，模拟不同浏览器/不同的人。 */
function client() {
  const jar = new Map();
  return async function request(method, urlPath, body) {
    const res = await fetch(BASE + urlPath, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(jar.size ? { Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    for (const raw of res.headers.getSetCookie ? res.headers.getSetCookie() : []) {
      const [pair] = raw.split(';');
      const i = pair.indexOf('=');
      jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }
    let data = null;
    try { data = await res.json(); } catch (_) { /* 无 body */ }
    return { status: res.status, data, cookies: jar };
  };
}

function waitForServer(tries = 60) {
  return new Promise((resolve, reject) => {
    const attempt = (n) => {
      const req = http.get(`${BASE}/healthz`, (res) => { res.resume(); resolve(); });
      req.on('error', () => {
        if (n <= 0) return reject(new Error('server did not start'));
        setTimeout(() => attempt(n - 1), 100);
      });
    };
    attempt(tries);
  });
}

/** 收集一个 SSE 频道上的事件名，用于验证实时推送确实发出去了。 */
function sseCollector(urlPath, cookieHeader) {
  const events = [];
  const req = http.get(
    `${BASE}${urlPath}`,
    { headers: cookieHeader ? { Cookie: cookieHeader } : {} },
    (res) => {
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        for (const line of chunk.split('\n')) {
          if (line.startsWith('event: ')) events.push(line.slice(7).trim());
        }
      });
    },
  );
  req.on('error', () => {});
  return { events, stop: () => req.destroy() };
}

async function main() {
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: { ...process.env, DAZI_PORT: String(PORT), DAZI_HOST: '127.0.0.1', DAZI_DATA_DIR: DATA_DIR },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  server.stdout.resume();

  try {
    await waitForServer();

    const host = client();      // 发起人
    const guest = client();     // 路人甲
    const stranger = client();  // 路人乙

    console.log('\n身份（免注册 + 统一性）');
    const me1 = await host('GET', '/api/me');
    check('首次访问自动签发身份', me1.status === 200 && me1.data.user.uid, JSON.stringify(me1.data));
    check('首次返回身份口令', Boolean(me1.data.recoveryCode));
    check('身份带短号用于全站辨识', Boolean(me1.data.user.tag));

    const me2 = await host('GET', '/api/me');
    check('同一浏览器再次访问身份不变', me2.data.user.uid === me1.data.user.uid);
    check('第二次不再下发口令', !me2.data.recoveryCode);

    const guestMe = await guest('GET', '/api/me');
    check('不同浏览器是不同身份', guestMe.data.user.uid !== me1.data.user.uid);

    const rename = await host('PATCH', '/api/me', { nick: '球场蹲点的柴犬' });
    check('可以改昵称', rename.status === 200 && rename.data.user.nick === '球场蹲点的柴犬');
    const clash = await guest('PATCH', '/api/me', { nick: '球场蹲点的柴犬' });
    check('昵称全站唯一（重名被拒）', clash.status === 409, `got ${clash.status}`);

    // 用身份口令在「新设备」上找回同一身份
    const otherDevice = client();
    const restored = await otherDevice('POST', '/api/session/restore', { code: me1.data.recoveryCode });
    check('换设备用口令找回同一身份', restored.status === 200 && restored.data.user.uid === me1.data.user.uid);
    const badRestore = await client()('POST', '/api/session/restore', { code: 'DAZI-XXXX-XXXX-XXXX-XXXX' });
    check('错误口令被拒绝', badRestore.status === 404);

    console.log('\n发帖与看板');
    const boardSse = sseCollector('/api/stream');
    await new Promise((r) => setTimeout(r, 150));

    const created = await host('POST', '/api/posts', {
      title: '周三晚东区球场',
      category: 'ball',
      desc: '菜鸡互啄，欢迎新手',
      campus: '紫金港校区',
      place: '东区体育馆',
      timeText: '周三 19:00',
      capacity: 4,
      options: [
        { label: '篮球', emoji: '🏀' },
        { label: '羽毛球', emoji: '🏸' },
        { label: '看电影', emoji: '🎬' },
      ],
    });
    check('发帖成功', created.status === 201, JSON.stringify(created.data));
    const postId = created.data && created.data.post.id;
    check('帖子支持多个选项', created.data.post.options.length === 3);
    check('发起人自动占位', created.data.post.memberCount === 1);
    check('帖子落在「招募中」泳道', created.data.post.column === 'open');

    const noOpts = await host('POST', '/api/posts', { title: '没选项目', options: [] });
    check('没有选项的帖子被拒绝', noOpts.status === 400);

    const board = await guest('GET', '/api/posts');
    check('看板能看到帖子', board.data.cards.some((c) => c.id === postId));

    console.log('\n加入 / 多选项投票');
    const optionB = created.data.post.options[1];
    const joined = await guest('POST', `/api/posts/${postId}/join`, { optionId: optionB.id });
    check('路人可以直接加入', joined.status === 200 && joined.data.post.memberCount === 2);
    check('加入时选中的项目被记录', joined.data.post.myOptionId === optionB.id);
    check('选项票数统计正确', joined.data.post.tally[optionB.id] === 1);

    const voted = await guest('POST', `/api/posts/${postId}/vote`, { optionId: created.data.post.options[2].id });
    check('可以改投别的项目', voted.data.post.tally[optionB.id] === 0);

    console.log('\n帖子内聊天');
    const postSse = sseCollector(
      `/api/posts/${postId}/stream`,
      [...joined.cookies].map(([k, v]) => `${k}=${v}`).join('; '),
    );
    await new Promise((r) => setTimeout(r, 150));

    const said = await guest('POST', `/api/posts/${postId}/messages`, { text: '几点集合呀？' });
    check('可以在帖子里发言', said.status === 201 && said.data.message.text === '几点集合呀？');
    check('发言署名是统一身份', said.data.message.author.uid === guestMe.data.user.uid);
    const empty = await guest('POST', `/api/posts/${postId}/messages`, { text: '   ' });
    check('空消息被拒绝', empty.status === 400);

    await new Promise((r) => setTimeout(r, 250));
    check('聊天通过 SSE 实时推送', postSse.events.includes('message'), postSse.events.join(','));
    check('看板变化通过 SSE 推送', boardSse.events.includes('board:new'), boardSse.events.join(','));

    console.log('\n锁帖：不让别人进来');
    const locked = await host('PATCH', `/api/posts/${postId}`, { locked: true });
    check('发起人可以锁帖', locked.status === 200 && locked.data.post.locked === true);

    const strangerView = await stranger('GET', `/api/posts/${postId}`);
    check('外人拿不到锁帖详情', strangerView.data.post.blocked === true);
    check('外人看不到聊天记录', strangerView.data.post.messages.length === 0);
    check('外人看不到描述与成员', strangerView.data.post.desc === '' && strangerView.data.post.members.length === 0);

    const strangerTalk = await stranger('POST', `/api/posts/${postId}/messages`, { text: '我能进吗' });
    check('外人不能在锁帖里发言', strangerTalk.status === 403);
    const strangerJoin = await stranger('POST', `/api/posts/${postId}/join`, {});
    check('外人不能加入锁帖', strangerJoin.status === 403);

    const memberView = await guest('GET', `/api/posts/${postId}`);
    check('已加入的成员仍能进入', memberView.data.post.blocked === false && memberView.data.post.messages.length > 0);
    const memberTalk = await guest('POST', `/api/posts/${postId}/messages`, { text: '锁了也能聊' });
    check('成员在锁帖里仍可发言', memberTalk.status === 201);
    check('锁帖在看板上落到「已锁定」泳道', (await guest('GET', '/api/posts')).data.cards.find((c) => c.id === postId).column === 'locked');

    console.log('\n锁帖暗号');
    await host('PATCH', `/api/posts/${postId}`, { locked: false });
    await host('PATCH', `/api/posts/${postId}`, { locked: true, lockCode: '篮球队暗号' });
    const wrongCode = await stranger('POST', `/api/posts/${postId}/join`, { code: '瞎猜的' });
    check('暗号错误进不去', wrongCode.status === 403);
    const rightCode = await stranger('POST', `/api/posts/${postId}/join`, { code: '篮球队暗号' });
    check('暗号正确可以进来', rightCode.status === 200 && rightCode.data.post.blocked === false);

    console.log('\n权限边界');
    const evilPatch = await guest('PATCH', `/api/posts/${postId}`, { title: '我改了' });
    check('非发起人不能改帖子', evilPatch.status === 403);
    const evilDelete = await guest('DELETE', `/api/posts/${postId}`);
    check('非发起人不能删帖子', evilDelete.status === 403);
    const evilKick = await guest('POST', `/api/posts/${postId}/kick`, { uid: me1.data.user.uid });
    check('非发起人不能踢人', evilKick.status === 403);
    const forged = await fetch(`${BASE}/api/me`, { headers: { Cookie: `dazi_id=${me1.data.user.uid}.forged` } });
    const forgedData = await forged.json();
    check('伪造签名的身份 cookie 无效', forgedData.user.uid !== me1.data.user.uid);

    console.log('\n容量与结束');
    await host('PATCH', `/api/posts/${postId}`, { locked: false, capacity: 3 });
    const fourth = client();
    await fourth('GET', '/api/me');
    const full = await fourth('POST', `/api/posts/${postId}/join`, {});
    check('人满后无法加入', full.status === 409, `got ${full.status}`);

    await host('PATCH', `/api/posts/${postId}`, { status: 'done' });
    check('可标记完成并进入「已完成」泳道',
      (await host('GET', '/api/posts')).data.cards.find((c) => c.id === postId).column === 'done');

    console.log('\n持久化');
    const del = await host('DELETE', `/api/posts/${postId}`);
    check('发起人可以删除帖子', del.status === 200);
    check('删除后帖子消失', (await host('GET', `/api/posts/${postId}`)).status === 404);
    check('数据文件已落盘', fs.existsSync(path.join(DATA_DIR, 'dazi.json')));

    boardSse.stop();
    postSse.stop();
  } finally {
    server.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 300));
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  }

  console.log(`\n通过 ${passed} 项，失败 ${failures.length} 项`);
  if (failures.length) {
    for (const f of failures) console.log(`  ✗ ${f}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
