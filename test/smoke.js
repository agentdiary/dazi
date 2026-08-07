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
const net = require('net');

const PORT = 8791;
const SMTP_PORT = 8792;
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

/**
 * 假的 SMTP 服务器：真的把协议走一遍并收下邮件，
 * 这样「发提醒邮件」这条路是端到端验证的，而不是只 mock 掉。
 */
function fakeSmtpServer(port) {
  const received = [];
  const server = net.createServer((socket) => {
    let buffer = '';
    let inData = false;
    let authStep = '';
    let mail = { to: '', body: '' };

    socket.write('220 fake-smtp ready\r\n');
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      for (;;) {
        const idx = buffer.indexOf('\r\n');
        if (idx < 0) break;
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);

        if (inData) {
          if (line === '.') {
            inData = false;
            received.push(mail);
            mail = { to: '', body: '' };
            socket.write('250 OK queued\r\n');
          } else {
            mail.body += `${line}\n`;
          }
          continue;
        }

        const upper = line.toUpperCase();
        if (upper.startsWith('EHLO') || upper.startsWith('HELO')) {
          socket.write('250-fake-smtp\r\n250 AUTH LOGIN\r\n');
        } else if (upper === 'AUTH LOGIN') {
          authStep = 'user';
          socket.write('334 VXNlcm5hbWU6\r\n');       // "Username:"
        } else if (authStep === 'user') {
          authStep = 'pass';
          socket.write('334 UGFzc3dvcmQ6\r\n');       // "Password:"
        } else if (authStep === 'pass') {
          authStep = 'done';
          socket.write('235 auth ok\r\n');
        } else if (upper.startsWith('MAIL FROM')) {
          socket.write('250 OK\r\n');
        } else if (upper.startsWith('RCPT TO')) {
          mail.to = (line.match(/<([^>]*)>/) || [])[1] || '';
          socket.write('250 OK\r\n');
        } else if (upper === 'DATA') {
          inData = true;
          socket.write('354 go ahead\r\n');
        } else if (upper === 'QUIT') {
          socket.write('221 bye\r\n');
          socket.end();
        } else {
          socket.write('250 OK\r\n');
        }
      }
    });
    socket.on('error', () => {});
  });
  server.listen(port, '127.0.0.1');
  return { received, close: () => server.close() };
}

/** 从收到的邮件里还原出 base64 正文。 */
function decodeMail(mail) {
  const parts = mail.body.split('\n\n');
  const headers = parts[0];
  const body = Buffer.from(parts.slice(1).join('').replace(/\s/g, ''), 'base64').toString('utf8');
  const rawSubject = (headers.match(/Subject: (.*)/) || [])[1] || '';
  const subject = rawSubject.startsWith('=?UTF-8?B?')
    ? Buffer.from(rawSubject.replace(/^=\?UTF-8\?B\?/, '').replace(/\?=$/, ''), 'base64').toString('utf8')
    : rawSubject;
  return { subject, body, to: mail.to };
}

function readDb() {
  return JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'dazi.json'), 'utf8'));
}

/**
 * 单独起一个开了 DAZI_REQUIRE_LOGIN=1 的实例，验证「强制登录」这条开关。
 * 这是同一套身份体系的另一种形态：浏览照常开放，写操作必须先有账号。
 */
async function testRequireLoginMode() {
  const port = PORT + 10;
  const base = `http://127.0.0.1:${port}`;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dazi-login-'));
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: {
      ...process.env,
      DAZI_PORT: String(port),
      DAZI_HOST: '127.0.0.1',
      DAZI_DATA_DIR: dataDir,
      DAZI_REQUIRE_LOGIN: '1',
      DAZI_ADMIN_USER: '',
      DAZI_ADMIN_PASS: '',
      DAZI_SMTP_HOST: '',
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  server.stdout.resume();

  const call = (jar) => async (method, urlPath, body) => {
    const res = await fetch(base + urlPath, {
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
    return { status: res.status, data };
  };

  try {
    // 等这个实例起来
    for (let i = 0; i < 60; i++) {
      try {
        await fetch(`${base}/healthz`);
        break;
      } catch (_) {
        await new Promise((r) => setTimeout(r, 100));
      }
    }

    console.log('\n强制登录模式（DAZI_REQUIRE_LOGIN=1）');
    const anon = call(new Map());
    const meta = await anon('GET', '/api/meta');
    check('meta 告诉前端本站要求登录', meta.data.requireLogin === true);
    check('匿名仍然可以浏览', (await anon('GET', '/api/posts')).status === 200);

    const anonPost = await anon('POST', '/api/posts', {
      title: '匿名想发帖', category: 'other', options: [{ label: '随便', emoji: '✨' }],
    });
    check('匿名不能发帖', anonPost.status === 401, `got ${anonPost.status}`);

    const registered = call(new Map());
    await registered('GET', '/api/me');
    await registered('POST', '/api/auth/register', { username: 'realuser', password: 'secret123' });
    const okPost = await registered('POST', '/api/posts', {
      title: '注册用户发的帖', category: 'other', options: [{ label: '篮球', emoji: '🏀' }],
    });
    check('注册后可以发帖', okPost.status === 201, JSON.stringify(okPost.data));

    const anonTalk = await anon('POST', `/api/posts/${okPost.data.post.id}/messages`, { text: '我想说话' });
    check('匿名不能发言', anonTalk.status === 401);
    const anonJoin = await anon('POST', `/api/posts/${okPost.data.post.id}/join`, {});
    check('匿名不能加入', anonJoin.status === 401);
  } finally {
    server.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 300));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

async function main() {
  const smtp = fakeSmtpServer(SMTP_PORT);
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: {
      ...process.env,
      DAZI_PORT: String(PORT),
      DAZI_HOST: '127.0.0.1',
      DAZI_DATA_DIR: DATA_DIR,
      // 把 30 分钟的门槛压到 300 毫秒，好在测试里跑完整条提醒链路
      DAZI_NOTIFY_DWELL_MS: '300',
      DAZI_NOTIFY_MIN_MESSAGES: '1',
      DAZI_SITE_URL: 'http://dazi.test',
      DAZI_SMTP_HOST: '127.0.0.1',
      DAZI_SMTP_PORT: String(SMTP_PORT),
      DAZI_SMTP_SECURE: '0',
      DAZI_SMTP_ALLOW_PLAINTEXT: '1',
      DAZI_SMTP_USER: 'dazi@test',
      DAZI_SMTP_PASS: 'secret',
      // 管理员账号由环境变量引导创建
      DAZI_ADMIN_USER: 'admin',
      DAZI_ADMIN_PASS: 'admin12345',
    },
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
    check('新帖状态是「招募中」', created.data.post.state === 'open');

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
    check('锁帖在列表上标为「已锁定」', (await guest('GET', '/api/posts')).data.cards.find((c) => c.id === postId).state === 'locked');

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
    check('可标记完成并变为「已完成」',
      (await host('GET', '/api/posts')).data.cards.find((c) => c.id === postId).state === 'done');

    console.log('\n排序与筛选');
    const sortNew = await host('GET', '/api/posts?sort=new');
    check('接口接受排序参数', sortNew.status === 200 && sortNew.data.sort === 'new');
    check('返回各状态的数量用于筛选面板', typeof sortNew.data.counts.all === 'number');
    const badSort = await host('GET', '/api/posts?sort=不存在的排序');
    check('非法排序回落到默认', badSort.data.sort === 'active');

    // 造几个帖子来验证排序真的生效
    const spare = client();
    await spare('GET', '/api/me');
    const mkPost = async (title, capacity) => (await spare('POST', '/api/posts', {
      title, category: 'other', capacity, options: [{ label: '随便', emoji: '✨' }],
    })).data.post.id;
    const small = await mkPost('两人小局', 2);
    const big = await mkPost('二十人大局', 20);

    const bySeats = await spare('GET', '/api/posts?sort=seats');
    const seatsOrder = bySeats.data.cards.map((c) => c.id);
    check('按空位排序：空位多的在前', seatsOrder.indexOf(big) < seatsOrder.indexOf(small),
      `big=${seatsOrder.indexOf(big)} small=${seatsOrder.indexOf(small)}`);

    const byNew = await spare('GET', '/api/posts?sort=new');
    check('按发布时间排序：最新的在最前', byNew.data.cards[0].id === big);

    const onlyOpen = await spare('GET', '/api/posts?state=open');
    check('按招募状态筛选只返回该状态', onlyOpen.data.cards.every((c) => c.state === 'open'));
    check('状态筛选把已完成的帖子挡掉', !onlyOpen.data.cards.some((c) => c.id === postId));

    console.log('\n在线状态');
    const presenceProbe = sseCollector('/api/stream', [...spare('GET', '/api/me').cookies || []].join(''));
    await new Promise((r) => setTimeout(r, 300));
    const withPresence = await host('GET', '/api/posts');
    check('接口返回全站在线人数', typeof withPresence.data.onlineNow === 'number' && withPresence.data.onlineNow >= 1,
      `onlineNow=${withPresence.data.onlineNow}`);
    check('卡片带上发起人在线状态', typeof withPresence.data.cards[0].hostOnline === 'boolean');
    presenceProbe.stop();

    console.log('\n停留 30 分钟 + 发过言 → 邮件提醒发起人');
    const notifyHost = client();
    await notifyHost('GET', '/api/me');
    await notifyHost('PATCH', '/api/me', { nick: '发提醒的柯基', email: 'host@dazi.test' });
    const meAfterEmail = await notifyHost('GET', '/api/me');
    check('邮箱保存成功且只有本人能看到', meAfterEmail.data.user.email === 'host@dazi.test');
    check('邮箱不出现在公开信息里',
      !JSON.stringify((await client()('GET', '/api/posts')).data).includes('host@dazi.test'));

    const notifyPost = await notifyHost('POST', '/api/posts', {
      title: '有人认真看的局', category: 'ball', capacity: 6,
      options: [{ label: '篮球', emoji: '🏀' }],
    });
    const nid = notifyPost.data.post.id;

    const visitor = client();
    const visitorMe = await visitor('GET', '/api/me');
    await visitor('PATCH', '/api/me', { nick: '认真看帖的水豚' });
    const visitorCookie = [...visitorMe.cookies].map(([k, v]) => `${k}=${v}`).join('; ');

    // 进房间待一会儿（超过压低后的 300ms 门槛），再发一条消息
    const room = sseCollector(`/api/posts/${nid}/stream`, visitorCookie);
    await new Promise((r) => setTimeout(r, 500));
    await visitor('POST', `/api/posts/${nid}/messages`, { text: '这个局我想去，几点开始？' });
    await new Promise((r) => setTimeout(r, 400));

    const visit = readDb().posts[nid].visits[visitorMe.data.user.uid];
    check('记录了访客的停留时长', visit && visit.dwellMs >= 300, `dwellMs=${visit && visit.dwellMs}`);
    check('记录了访客的发言条数', visit && visit.messages === 1);
    check('满足条件后标记为已提醒', visit && visit.notified === true);

    check('提醒邮件已发出', smtp.received.length >= 1, `收到 ${smtp.received.length} 封`);
    if (smtp.received.length) {
      const mail = decodeMail(smtp.received[smtp.received.length - 1]);
      check('邮件发给了发起人', mail.to === 'host@dazi.test', mail.to);
      check('邮件主题含访客昵称与帖子标题',
        mail.subject.includes('认真看帖的水豚') && mail.subject.includes('有人认真看的局'), mail.subject);
      check('邮件正文含停留时长与发言数', /停留/.test(mail.body) && /发言　：1 条/.test(mail.body), mail.body.slice(0, 200));
      check('邮件正文带可直接点开的帖子链接', mail.body.includes(`http://dazi.test/?post=${nid}`));
    }

    const before = smtp.received.length;
    await visitor('POST', `/api/posts/${nid}/messages`, { text: '再问一句' });
    await new Promise((r) => setTimeout(r, 300));
    check('同一个人在同一个帖子里只提醒一次', smtp.received.length === before, `又发了 ${smtp.received.length - before} 封`);

    // 发起人自己在自己帖子里待着不该触发提醒
    const hostRoom = sseCollector(`/api/posts/${nid}/stream`,
      [...notifyPost.cookies].map(([k, v]) => `${k}=${v}`).join('; '));
    await new Promise((r) => setTimeout(r, 500));
    await notifyHost('POST', `/api/posts/${nid}/messages`, { text: '欢迎欢迎' });
    await new Promise((r) => setTimeout(r, 300));
    check('发起人自己不会触发提醒', smtp.received.length === before);
    room.stop();
    hostRoom.stop();

    // 关掉开关之后不再发信
    const quiet = client();
    await quiet('GET', '/api/me');
    await quiet('PATCH', '/api/me', { nick: '不想被打扰的树懒', email: 'quiet@dazi.test', notifyEmail: false });
    const quietPost = await quiet('POST', '/api/posts', {
      title: '安静的局', category: 'other', capacity: 5, options: [{ label: '自习', emoji: '📚' }],
    });
    const qid = quietPost.data.post.id;
    const quietVisitor = client();
    const qv = await quietVisitor('GET', '/api/me');
    const qRoom = sseCollector(`/api/posts/${qid}/stream`,
      [...qv.cookies].map(([k, v]) => `${k}=${v}`).join('; '));
    await new Promise((r) => setTimeout(r, 500));
    await quietVisitor('POST', `/api/posts/${qid}/messages`, { text: '有人吗' });
    await new Promise((r) => setTimeout(r, 400));
    check('关掉邮件提醒后不再发信', smtp.received.length === before);
    check('但站内仍然记录了这次访问',
      readDb().posts[qid].visits[qv.data.user.uid].notified === true);
    qRoom.stop();

    console.log('\n注册 / 登录');
    const newbie = client();
    const newbieMe = await newbie('GET', '/api/me');
    const newbieUid = newbieMe.data.user.uid;
    const newbieNick = newbieMe.data.user.nick;

    // 先以匿名身份发个帖，验证注册后这些内容还跟着走
    const preRegPost = await newbie('POST', '/api/posts', {
      title: '注册前发的帖', category: 'other', capacity: 4,
      options: [{ label: '随便', emoji: '✨' }],
    });
    check('匿名身份可以先发帖（免注册仍然成立）', preRegPost.status === 201);

    const badName = await newbie('POST', '/api/auth/register', { username: 'ab', password: 'secret123' });
    check('用户名太短被拒', badName.status === 400);
    const badPass = await newbie('POST', '/api/auth/register', { username: 'xiaoming', password: '123' });
    check('密码太短被拒', badPass.status === 400);

    const reg = await newbie('POST', '/api/auth/register', { username: 'xiaoming', password: 'secret123' });
    check('注册成功', reg.status === 200 && reg.data.user.username === 'xiaoming');
    check('注册不新建身份，uid 保持不变', reg.data.user.uid === newbieUid);
    check('注册后昵称保持不变', reg.data.user.nick === newbieNick);
    check('注册前发的帖子仍属于自己',
      (await newbie('GET', `/api/posts/${preRegPost.data.post.id}`)).data.post.isHost === true);

    const dupUser = await client()('POST', '/api/auth/register', { username: 'XiaoMing', password: 'secret123' });
    check('用户名唯一（忽略大小写）', dupUser.status === 400, `got ${dupUser.status}`);
    const regTwice = await newbie('POST', '/api/auth/register', { username: 'another', password: 'secret123' });
    check('同一身份不能重复注册', regTwice.status === 400);

    const otherPc = client();
    const wrongPw = await otherPc('POST', '/api/auth/login', { username: 'xiaoming', password: 'wrongpass' });
    check('密码错误登录失败', wrongPw.status === 401);
    const noUser = await otherPc('POST', '/api/auth/login', { username: 'nobody-here', password: 'whatever' });
    check('用户不存在也返回同样的错误', noUser.status === 401 && noUser.data.error === wrongPw.data.error);

    const login = await otherPc('POST', '/api/auth/login', { username: 'xiaoming', password: 'secret123' });
    check('换设备用账号密码登录', login.status === 200 && login.data.user.uid === newbieUid);
    check('登录后拿回原来的帖子',
      (await otherPc('GET', `/api/posts/${preRegPost.data.post.id}`)).data.post.isHost === true);

    const badOld = await newbie('POST', '/api/auth/password', { oldPassword: 'nope', newPassword: 'newsecret1' });
    check('改密码要验原密码', badOld.status === 400);
    const changed = await newbie('POST', '/api/auth/password', { oldPassword: 'secret123', newPassword: 'newsecret1' });
    check('改密码成功', changed.status === 200);
    check('新密码可登录',
      (await client()('POST', '/api/auth/login', { username: 'xiaoming', password: 'newsecret1' })).status === 200);
    check('旧密码失效',
      (await client()('POST', '/api/auth/login', { username: 'xiaoming', password: 'secret123' })).status === 401);

    const loggedOut = await otherPc('POST', '/api/auth/logout', {});
    check('退出登录后回到全新匿名身份',
      loggedOut.status === 200 && loggedOut.data.user.uid !== newbieUid && !loggedOut.data.user.username);

    check('密码哈希不出现在任何响应里',
      !JSON.stringify(reg.data).includes('scrypt') && !JSON.stringify(login.data).includes('scrypt'));
    check('别人看不到你的用户名',
      !JSON.stringify((await client()('GET', '/api/posts')).data).includes('xiaoming'));

    console.log('\n管理员');
    const adminClient = client();
    const adminLogin = await adminClient('POST', '/api/auth/login', { username: 'admin', password: 'admin12345' });
    check('环境变量里的管理员账号已自动创建', adminLogin.status === 200, JSON.stringify(adminLogin.data));
    check('管理员身份带 admin 标记', adminLogin.data.user.admin === true);

    const notAdmin = await newbie('GET', '/api/admin/overview');
    check('普通用户进不了管理接口', notAdmin.status === 403);
    const anonAdmin = await client()('GET', '/api/admin/users');
    check('匿名用户进不了管理接口', anonAdmin.status === 403);

    const ov = await adminClient('GET', '/api/admin/overview');
    check('管理员能看站点概览', ov.status === 200 && typeof ov.data.stats.users === 'number');
    const adminUsers = await adminClient('GET', '/api/admin/users?q=xiaoming');
    check('管理员能按关键词搜用户', adminUsers.data.users.some((u) => u.username === 'xiaoming'));
    const adminPosts = await adminClient('GET', '/api/admin/posts');
    check('管理员能看帖子列表', Array.isArray(adminPosts.data.posts) && adminPosts.data.posts.length > 0);

    // 管理员可以管别人的帖子
    const someonePost = preRegPost.data.post.id;
    const adminLock = await adminClient('PATCH', `/api/posts/${someonePost}`, { locked: true });
    check('管理员能锁别人的帖子', adminLock.status === 200 && adminLock.data.post.locked === true);
    await adminClient('PATCH', `/api/posts/${someonePost}`, { locked: false });

    // 封禁
    const ban = await adminClient('POST', `/api/admin/users/${newbieUid}/ban`, { banned: true });
    check('管理员能封禁用户', ban.status === 200);
    const bannedPost = await newbie('POST', '/api/posts', {
      title: '封禁后还想发帖', category: 'other', options: [{ label: '随便', emoji: '✨' }],
    });
    check('被封禁后不能发帖', bannedPost.status === 403, `got ${bannedPost.status}`);
    const bannedTalk = await newbie('POST', `/api/posts/${someonePost}/messages`, { text: '我还能说话吗' });
    check('被封禁后不能发言', bannedTalk.status === 403);
    check('被封禁后不能登录',
      (await client()('POST', '/api/auth/login', { username: 'xiaoming', password: 'newsecret1' })).status === 401);
    check('被封禁后仍能浏览', (await newbie('GET', '/api/posts')).status === 200);

    await adminClient('POST', `/api/admin/users/${newbieUid}/ban`, { banned: false });
    check('解封后恢复发言',
      (await newbie('POST', `/api/posts/${someonePost}/messages`, { text: '我回来了' })).status === 201);

    const selfBan = await adminClient('POST', `/api/admin/users/${adminLogin.data.user.uid}/ban`, { banned: true });
    check('管理员不能封禁自己', selfBan.status === 400);
    const lastAdmin = await adminClient('POST', `/api/admin/users/${adminLogin.data.user.uid}/role`, { role: 'user' });
    check('不能把自己降权（防止后台锁死）', lastAdmin.status === 400);

    // 管理员删消息
    const msgs = (await adminClient('GET', `/api/posts/${someonePost}`)).data.post.messages;
    const realMsg = msgs.find((m) => m.kind === 'msg');
    const delMsg = await adminClient('DELETE', `/api/admin/posts/${someonePost}/messages/${realMsg.id}`);
    check('管理员能删除违规消息', delMsg.status === 200);
    check('删除后消息不在了',
      !(await adminClient('GET', `/api/posts/${someonePost}`)).data.post.messages.some((m) => m.id === realMsg.id));

    const promoted = await adminClient('POST', `/api/admin/users/${newbieUid}/role`, { role: 'admin' });
    check('管理员能提升他人为管理员', promoted.status === 200);
    check('被提升者能进管理后台', (await newbie('GET', '/api/admin/overview')).status === 200);
    await adminClient('POST', `/api/admin/users/${newbieUid}/role`, { role: 'user' });
    check('降权后进不去后台', (await newbie('GET', '/api/admin/overview')).status === 403);

    const adminDel = await adminClient('DELETE', `/api/posts/${someonePost}`);
    check('管理员能删除任何帖子', adminDel.status === 200);

    console.log('\n中英双语');
    const enFetch = (method, urlPath, body) => fetch(BASE + urlPath, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Dazi-Lang': 'en' },
      body: body ? JSON.stringify(body) : undefined,
    });

    const metaEn = await (await enFetch('GET', '/api/meta')).json();
    check('分类带英文标签', metaEn.categories.every((c) => c.labelEn), JSON.stringify(metaEn.categories[0]));
    check('状态带英文标签和说明', metaEn.states.every((s) => s.labelEn && s.hintEn));
    check('排序带英文标签', metaEn.sorts.every((s) => s.labelEn));
    check('预设项目带英文标签', metaEn.presetOptions.every((o) => o.labelEn));

    const errEn = await (await enFetch('GET', '/api/posts/deadbeefdead')).json();
    check('英文请求返回英文错误', errEn.error === 'This post does not exist or has been deleted', errEn.error);
    const errZh = await client()('GET', '/api/posts/deadbeefdead');
    check('中文请求仍返回中文错误', errZh.data.error === '这个帖子不存在或已被删除');

    // 帖子里存的是中文项目名，序列化时要补回英文名（老数据也照顾到）
    const optPost = await host('POST', '/api/posts', {
      title: '双语选项测试', category: 'ball', capacity: 4,
      options: [{ label: '篮球', emoji: '🏀' }, { label: '我自定义的项目', emoji: '✨' }],
    });
    const optsEn = optPost.data.post.options;
    check('预设项目补回英文名', optsEn[0].labelEn === 'Basketball', JSON.stringify(optsEn[0]));
    check('自定义项目不硬翻，保持原样', !optsEn[1].labelEn);

    // 英文浏览器首次访问应拿到英文昵称
    const enVisitor = await (await enFetch('GET', '/api/me')).json();
    check('英文访客拿到英文昵称', /^[A-Za-z][A-Za-z\- ]+$/.test(enVisitor.user.nick), enVisitor.user.nick);
    const zhVisitor = await client()('GET', '/api/me');
    check('中文访客仍是中文昵称', /[一-龥]/.test(zhVisitor.data.user.nick), zhVisitor.data.user.nick);

    await host('DELETE', `/api/posts/${optPost.data.post.id}`);

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
    smtp.close();
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  }

  await testRequireLoginMode();

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
