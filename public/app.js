/* 校园搭子 · 前端。原生 JS，无构建步骤。 */
'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

// i18n 快捷方式：t 翻译文案，L 取 meta 项的本地化标签
const t = (zh, vars) => I18N.t(zh, vars);
const L = (item) => I18N.label(item);

const state = {
  me: null,
  meta: null,
  cards: [],
  counts: {},
  category: '',
  query: '',
  mineOnly: false,
  sort: 'active',     // 排序方式
  stateFilter: '',    // 招募状态筛选
  onlineNow: 0,
  detail: null,       // 当前打开的帖子详情
  boardSource: null,  // 首页 SSE
  postSource: null,   // 帖子内 SSE
  draft: { category: 'ball', options: [] },
  authMode: 'login',   // 登录 / 注册 弹窗当前处于哪个页签
  adminTab: 'users',   // 管理后台当前页签
};

/* ------------------------------------------------------------------ 工具 */

async function api(path, options = {}) {
  const res = await fetch(path, {
    credentials: 'same-origin',
    ...options,
    // 带上语言，服务端的错误信息也会跟着切
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      'X-Dazi-Lang': I18N.get(),
      ...(options.headers || {}),
    },
  });
  let data = null;
  try { data = await res.json(); } catch (_) { /* 空响应 */ }
  if (!res.ok) throw new Error((data && data.error) || `请求失败（${res.status}）`);
  return data;
}

let toastTimer = null;
function toast(text) {
  const el = $('#toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
}

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;   // 永远用 textContent，杜绝 XSS
    else if (key === 'html') node.innerHTML = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (key === 'style') Object.assign(node.style, value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child.nodeType ? child : document.createTextNode(child));
  }
  return node;
}

function avatar(user, size) {
  const node = el('span', {
    class: 'avatar',
    title: `${user.nick} #${user.tag}`,
    text: user.emoji || '🙂',
    style: { background: user.color || 'var(--surface-2)' },
  });
  if (size) { node.style.width = node.style.height = `${size}px`; }
  return node;
}

/** 带在线小绿点的头像。online 为 undefined 时不显示状态。 */
function avatarWithPresence(user, online) {
  const wrap = el('span', { class: 'avatar-wrap' }, [avatar(user)]);
  if (online !== undefined) {
    wrap.append(el('i', {
      class: `dot-online${online ? '' : ' off'}`,
      title: online ? t('在线') : t('离线'),
    }));
  }
  return wrap;
}

function timeAgo(ts) {
  const diff = Date.now() - ts;
  if (diff < 60_000) return t('刚刚');
  if (diff < 3600_000) return t('{n} 分钟前', { n: Math.floor(diff / 60_000) });
  if (diff < 86_400_000) return t('{n} 小时前', { n: Math.floor(diff / 3600_000) });
  return t('{n} 天前', { n: Math.floor(diff / 86_400_000) });
}

function clock(ts) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/* ---------------------------------------------------------------- 帖子流 */

async function loadBoard() {
  const params = new URLSearchParams();
  if (state.category) params.set('category', state.category);
  if (state.query) params.set('q', state.query);
  if (state.mineOnly) params.set('mine', '1');
  if (state.stateFilter) params.set('state', state.stateFilter);
  if (state.sort !== 'active') params.set('sort', state.sort);
  const data = await api(`/api/posts?${params}`);
  state.cards = data.cards;
  state.counts = data.counts || {};
  state.onlineNow = data.onlineNow || 0;
  if (data.me) state.me = { ...state.me, ...data.me };
  renderMe();
  renderFeed();
  renderFilterPanel();
  renderOnlineNow();
}

function renderOnlineNow() {
  const node = $('#onlineNow');
  node.replaceChildren(
    el('i', { class: 'dot-online' }),
    document.createTextNode(t('{n} 人在线', { n: state.onlineNow })),
  );
}

function renderFilters() {
  const box = $('#filters');
  box.replaceChildren();
  const all = el('button', {
    class: 'filter-chip', type: 'button', 'aria-pressed': String(!state.category),
    text: t('🌐 全部'),
    onclick: () => { state.category = ''; renderFilters(); loadBoard(); },
  });
  box.append(all);
  for (const cat of state.meta.categories) {
    box.append(el('button', {
      class: 'filter-chip', type: 'button',
      'aria-pressed': String(state.category === cat.id),
      text: `${cat.emoji} ${L(cat)}`,
      onclick: () => { state.category = cat.id; renderFilters(); loadBoard(); },
    }));
  }
}

function cardNode(card) {
  const cat = state.meta.categories.find((c) => c.id === card.category);
  const node = el('article', {
    class: `card${card.locked ? ' is-locked' : ''}`,
    'data-id': card.id,
    tabindex: '0',
    role: 'button',
    onclick: () => openDetail(card.id),
    onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(card.id); } },
  });

  // 招募状态从「版面分栏」降级成卡片上的徽标，帖子多少不再影响布局
  const stateMeta = state.meta.states.find((s) => s.id === card.state);
  const badges = [];
  if (stateMeta) {
    badges.push(el('span', {
      class: `badge ${card.state}`,
      text: `${stateMeta.emoji} ${L(stateMeta)}`,
      title: I18N.hint(stateMeta),
    }));
  }
  if (card.locked && card.hasLockCode) badges.push(el('span', { class: 'badge lock', text: t('需暗号') }));
  if (card.isHost) badges.push(el('span', { class: 'badge mine', text: t('我发起') }));
  else if (card.isMember) badges.push(el('span', { class: 'badge mine', text: t('已加入') }));

  node.append(el('div', { class: 'card-top' }, [
    el('h3', { class: 'card-title', text: card.title }),
    ...badges,
  ]));

  const opts = el('div', { class: 'card-opts' });
  for (const opt of card.options.slice(0, 6)) {
    const chip = el('span', { class: 'opt-chip', text: `${opt.emoji} ${L(opt)}` });
    const n = card.tally ? card.tally[opt.id] : 0;
    if (n) chip.append(el('span', { class: 'n', text: `×${n}` }));
    opts.append(chip);
  }
  if (card.options.length > 6) opts.append(el('span', { class: 'opt-chip', text: `+${card.options.length - 6}` }));
  node.append(opts);

  const meta = el('div', { class: 'card-meta' });
  if (cat) meta.append(el('span', { text: `${cat.emoji} ${L(cat)}` }));
  if (card.timeText) meta.append(el('span', { text: `🕒 ${card.timeText}` }));
  if (card.campus) meta.append(el('span', { text: `📍 ${card.campus}` }));
  if (card.messageCount) meta.append(el('span', { text: `💬 ${card.messageCount}` }));
  node.append(meta);

  const pct = Math.min(100, Math.round((card.memberCount / Math.max(card.capacity, 1)) * 100));
  node.append(el('div', { class: 'progress' }, [el('i', { style: { width: `${pct}%` } })]));

  const foot = el('div', { class: 'card-foot' }, [
    el('div', { class: 'stack' }, [avatarWithPresence(card.host, card.hostOnline)]),
  ]);
  if (card.onlineCount > 0) {
    foot.append(el('span', {
      class: 'online-pill',
      title: t('{n} 在线', { n: card.onlineCount }),
    }, [el('i', { class: 'dot-online' }), document.createTextNode(t('{n} 在线', { n: card.onlineCount }))]));
  }
  foot.append(el('span', {
    class: 'seats',
    html: `<b>${card.memberCount}</b>/${card.capacity} · ${timeAgo(card.updatedAt)}`,
  }));
  node.append(foot);
  return node;
}

function renderFeed() {
  const feed = $('#feed');
  feed.replaceChildren();

  if (state.cards.length === 0) {
    const filtered = state.category || state.query || state.stateFilter || state.mineOnly;
    feed.append(el('div', { class: 'feed-empty' }, [
      el('div', { class: 'big', text: filtered ? '🔍' : '🌱' }),
      el('h3', { text: filtered ? t('没有符合条件的搭子局') : t('还没有人发起搭子局') }),
      el('p', { text: filtered ? t('换个分类或把筛选条件放宽试试') : t('点右上角「发起搭子」，当第一个吧') }),
    ]));
    return;
  }
  for (const card of state.cards) feed.append(cardNode(card));
}

/* ------------------------------------------------------- 筛选与排序面板 */

function renderFilterPanel() {
  const sortBox = $('#sortOptions');
  sortBox.replaceChildren();
  for (const sort of state.meta.sorts) {
    sortBox.append(el('button', {
      class: 'panel-opt', type: 'button',
      'aria-pressed': String(state.sort === sort.id),
      onclick: () => { state.sort = sort.id; loadBoard(); },
    }, [
      el('span', { text: sort.emoji }),
      el('span', { text: L(sort) }),
    ]));
  }

  const stateBox = $('#stateOptions');
  stateBox.replaceChildren();
  const rows = [{ id: '', label: '全部', labelEn: 'All', emoji: '📋' }, ...state.meta.states];
  for (const row of rows) {
    const count = row.id ? state.counts[row.id] : state.counts.all;
    stateBox.append(el('button', {
      class: 'panel-opt', type: 'button',
      'aria-pressed': String(state.stateFilter === row.id),
      title: I18N.hint(row) || '',
      onclick: () => { state.stateFilter = row.id; loadBoard(); },
    }, [
      el('span', { text: row.emoji }),
      el('span', { text: L(row) }),
      el('span', { class: 'n', text: String(count || 0) }),
    ]));
  }

  // 按钮上直接显示当前生效的筛选，不用打开面板也能看到
  const sortMeta = state.meta.sorts.find((s) => s.id === state.sort);
  const stateMeta = state.meta.states.find((s) => s.id === state.stateFilter);
  const label = [stateMeta && L(stateMeta), sortMeta && L(sortMeta)].filter(Boolean).join(' · ');
  $('#filterLabel').textContent = label || t('筛选');
  $('#filterBtn').classList.toggle('active', Boolean(state.stateFilter) || state.sort !== 'active');
}

function toggleFilterPanel(force) {
  const panel = $('#filterPanel');
  const open = force !== undefined ? force : panel.hidden;
  panel.hidden = !open;
  $('#filterBtn').setAttribute('aria-expanded', String(open));
}

/* --------------------------------------------------------------- 帖子详情 */

async function openDetail(id) {
  try {
    const data = await api(`/api/posts/${id}`);
    state.detail = data.post;
    $('#detailOverlay').hidden = false;
    renderDetail();
    connectPostStream(id);
  } catch (err) { toast(err.message); }
}

function closeDetail() {
  $('#detailOverlay').hidden = true;
  state.detail = null;
  if (state.postSource) { state.postSource.close(); state.postSource = null; }
  loadBoard();
}

async function refreshDetail() {
  if (!state.detail) return;
  try {
    const data = await api(`/api/posts/${state.detail.id}`);
    state.detail = data.post;
    renderDetail();
  } catch (_) { /* 帖子可能已被删除 */ }
}

function renderDetail() {
  const post = state.detail;
  if (!post) return;
  const cat = state.meta.categories.find((c) => c.id === post.category);

  $('#detailTitle').textContent = post.title;
  const sub = $('#detailSub');
  sub.replaceChildren();
  sub.append(
    `${cat ? L(cat) + ' · ' : ''}${t('由 {nick} 发起', { nick: `${post.host.nick} #${post.host.tag}` })} · ${timeAgo(post.createdAt)}`,
  );

  const body = $('#detailBody');
  body.replaceChildren();

  if (post.blocked) {
    body.style.gridTemplateColumns = '1fr';
    body.append(lockedNote(post));
    return;
  }
  body.style.gridTemplateColumns = '';
  body.append(detailSide(post), chatPanel(post));
  scrollChatToEnd();
}

function lockedNote(post) {
  const wrap = el('div', { class: 'locked-note' }, [
    el('div', { class: 'big', text: '🔒' }),
    el('h3', { text: t('这个帖子被发起人锁上了') }),
    el('p', {
      text: post.hasLockCode
        ? t('发起人设置了进入暗号。知道暗号的话，在下面输入就能进来一起聊。')
        : t('锁定之后只有已经加入的成员能看到内容和聊天。可以先私下问问发起人。'),
    }),
  ]);
  if (post.hasLockCode) {
    const input = el('input', { placeholder: t('输入暗号'), maxlength: '24' });
    const btn = el('button', {
      class: 'primary-btn', type: 'button', text: t('进入'),
      onclick: async () => {
        try {
          await api(`/api/posts/${post.id}/join`, {
            method: 'POST',
            body: JSON.stringify({ code: input.value }),
          });
          toast(t('暗号正确，欢迎加入！'));
          openDetail(post.id);
        } catch (err) { toast(err.message); }
      },
    });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') btn.click(); });
    wrap.append(el('div', { class: 'recovery-actions' }, [input, btn]));
  }
  return wrap;
}

function detailSide(post) {
  const side = el('aside', { class: 'detail-side' });

  if (post.desc) {
    side.append(el('div', { class: 'section-title', text: t('说明') }));
    side.append(el('p', { class: 'detail-desc', text: post.desc }));
  }

  side.append(el('div', { class: 'section-title', text: t('信息') }));
  const dl = el('div');
  const rows = [
    ['时间', post.timeText],
    ['地点', post.place],
    ['校区', post.campus],
    ['人数', `${post.memberCount} / ${post.capacity}`],
  ].filter(([, v]) => v);
  for (const [k, v] of rows) {
    dl.append(el('dl', { class: 'kv' }, [el('dt', { text: t(k) }), el('dd', { text: v })]));
  }
  side.append(dl);

  /* 多选项投票 */
  side.append(el('div', {
    class: 'section-title',
    text: post.isMember ? t('想一起做什么（点一下改选）') : t('备选项目'),
  }));
  const votes = el('div', { class: 'vote-list' });
  const total = Math.max(1, post.memberCount);
  for (const opt of post.options) {
    const n = (post.tally && post.tally[opt.id]) || 0;
    const row = el('button', {
      class: 'vote-row', type: 'button',
      'aria-pressed': String(post.myOptionId === opt.id),
      onclick: () => chooseOption(post, opt.id),
    }, [
      el('i', { class: 'bar', style: { width: `${(n / total) * 100}%` } }),
      el('span', { text: opt.emoji }),
      el('span', { text: L(opt) }),
      el('span', { class: 'count', text: t('{n} 人', { n }) }),
    ]);
    votes.append(row);
  }
  side.append(votes);

  /* 成员 */
  const onlineMembers = post.members.filter((m) => m.online).length;
  side.append(el('div', {
    class: 'section-title',
    text: onlineMembers
      ? t('成员 {n} · {online} 人在线', { n: post.members.length, online: onlineMembers })
      : t('成员 {n}', { n: post.members.length }),
  }));
  const members = el('div', { class: 'member-list' });
  for (const m of post.members) {
    const opt = post.options.find((o) => o.id === m.optionId);
    const row = el('div', { class: 'member-row' }, [
      avatarWithPresence(m, m.online),
      el('span', { text: m.nick }),
      el('span', { class: 'tag', text: `#${m.tag}` }),
      m.isHost ? el('span', { class: 'role', text: t('发起人') }) : null,
      m.admin ? el('span', { class: 'badge lock', text: t('管理员') }) : null,
      m.inRoom ? el('span', { class: 'online-pill', text: t('在房间里') }) : null,
      opt ? el('span', { class: 'opt-chip', text: `${opt.emoji}${L(opt)}` }) : null,
    ]);
    if (post.isHost && !m.isHost) {
      row.append(el('button', {
        class: 'ghost-btn kick', type: 'button', text: t('移出'),
        onclick: async () => {
          if (!confirm(t('把 {nick} 移出这个局？', { nick: m.nick }))) return;
          try {
            await api(`/api/posts/${post.id}/kick`, { method: 'POST', body: JSON.stringify({ uid: m.uid }) });
            refreshDetail();
          } catch (err) { toast(err.message); }
        },
      }));
    }
    members.append(row);
  }
  side.append(members);

  /* 操作区 */
  side.append(el('div', { class: 'section-title', text: t('操作') }));
  const tools = el('div', { class: 'host-tools' });

  if (!post.isMember && post.status !== 'done') {
    tools.append(el('button', {
      class: 'primary-btn', type: 'button', text: t('＋ 我要加入'),
      onclick: () => joinPost(post),
    }));
  } else if (post.isMember && !post.isHost) {
    tools.append(el('button', {
      class: 'ghost-btn', type: 'button', text: t('退出这个局'),
      onclick: async () => {
        try { await api(`/api/posts/${post.id}/leave`, { method: 'POST' }); refreshDetail(); }
        catch (err) { toast(err.message); }
      },
    }));
  }

  if (post.isHost) {
    tools.append(el('button', {
      class: 'ghost-btn', type: 'button',
      text: post.locked ? t('🔓 解锁帖子') : t('🔒 锁住帖子'),
      onclick: () => toggleLock(post),
    }));
    tools.append(el('button', {
      class: 'ghost-btn', type: 'button',
      text: post.status === 'done' ? t('↩︎ 重新开放') : t('🎉 标记完成'),
      onclick: async () => {
        try {
          await api(`/api/posts/${post.id}`, {
            method: 'PATCH',
            body: JSON.stringify({ status: post.status === 'done' ? 'open' : 'done' }),
          });
          refreshDetail();
        } catch (err) { toast(err.message); }
      },
    }));
    tools.append(el('button', {
      class: 'ghost-btn danger', type: 'button', text: t('删除'),
      onclick: async () => {
        if (!confirm(t('删除后聊天记录也会消失，确定？'))) return;
        try {
          await api(`/api/posts/${post.id}`, { method: 'DELETE' });
          toast(t('已删除'));
          closeDetail();
        } catch (err) { toast(err.message); }
      },
    }));
  }
  side.append(tools);

  if (post.locked) {
    side.append(el('p', {
      class: 'tiny',
      text: post.hasLockCode
        ? t('当前已锁定：只有成员，或知道暗号的人才能进来。')
        : t('当前已锁定：只有已加入的成员能进来。'),
    }));
  }
  return side;
}

async function chooseOption(post, optionId) {
  if (!post.isMember) return joinPost(post, optionId);
  try {
    const data = await api(`/api/posts/${post.id}/vote`, {
      method: 'POST', body: JSON.stringify({ optionId }),
    });
    state.detail = data.post;
    renderDetail();
  } catch (err) { toast(err.message); }
}

async function joinPost(post, optionId) {
  try {
    const data = await api(`/api/posts/${post.id}/join`, {
      method: 'POST',
      body: JSON.stringify({ optionId: optionId || post.options[0].id }),
    });
    state.detail = data.post;
    renderDetail();
    toast(t('加入成功，去聊两句吧'));
  } catch (err) { toast(err.message); }
}

async function toggleLock(post) {
  if (post.locked) {
    try {
      await api(`/api/posts/${post.id}`, { method: 'PATCH', body: JSON.stringify({ locked: false }) });
      toast(t('已解锁'));
      refreshDetail();
    } catch (err) { toast(err.message); }
    return;
  }
  const code = prompt(
    t('锁住之后，没加入的人看不到内容也进不来。\n\n可选：设一个暗号，知道暗号的人仍可进入（留空则完全不让新人进）。'),
    '',
  );
  if (code === null) return;
  try {
    await api(`/api/posts/${post.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ locked: true, lockCode: code.trim() }),
    });
    toast(code.trim() ? t('已锁定，凭暗号可进 🔒') : t('已锁定，别人进不来了 🔒'));
    refreshDetail();
  } catch (err) { toast(err.message); }
}

/* ----------------------------------------------------------------- 聊天 */

function chatPanel(post) {
  const log = el('div', { class: 'chat-log', id: 'chatLog' });
  for (const msg of post.messages) log.append(messageNode(msg));

  const box = el('textarea', {
    rows: '1', maxlength: String(state.meta.limits.message),
    placeholder: post.status === 'done' && !post.isMember ? t('这个局已经结束了') : t('说点什么…（Enter 发送）'),
  });
  box.addEventListener('input', () => {
    box.style.height = 'auto';
    box.style.height = `${Math.min(box.scrollHeight, 110)}px`;
  });
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });

  const btn = el('button', { class: 'primary-btn', type: 'button', text: t('发送'), onclick: () => send() });

  async function send() {
    const text = box.value.trim();
    if (!text) return;
    box.value = '';
    box.style.height = 'auto';
    try {
      await api(`/api/posts/${post.id}/messages`, { method: 'POST', body: JSON.stringify({ text }) });
    } catch (err) {
      toast(err.message);
      box.value = text;
    }
  }

  return el('div', { class: 'detail-chat' }, [
    log,
    el('div', { class: 'chat-form' }, [box, btn]),
  ]);
}

function messageNode(msg) {
  if (msg.kind === 'system') {
    return el('div', { class: 'msg system' }, [el('div', { class: 'msg-text', text: msg.text })]);
  }
  const self = state.me && msg.author && msg.author.uid === state.me.uid;
  return el('div', { class: `msg${self ? ' self' : ''}` }, [
    avatar(msg.author),
    el('div', { class: 'msg-main' }, [
      el('div', { class: 'msg-head' }, [
        el('b', { text: msg.author.nick }),
        el('span', { class: 'tag', text: `#${msg.author.tag}` }),
        el('span', { text: clock(msg.ts) }),
      ]),
      el('div', { class: 'msg-text', text: msg.text }),
    ]),
  ]);
}

function scrollChatToEnd() {
  const log = $('#chatLog');
  if (log) log.scrollTop = log.scrollHeight;
}

/* ------------------------------------------------------------ 实时连接 */

function connectBoardStream() {
  if (state.boardSource) state.boardSource.close();
  const source = new EventSource('/api/stream');
  state.boardSource = source;
  const conn = $('#connState');

  source.addEventListener('open', () => {
    conn.className = 'conn live';
    conn.replaceChildren(el('i'), document.createTextNode(t('实时同步中')));
  });
  source.addEventListener('error', () => {
    conn.className = 'conn dead';
    conn.replaceChildren(el('i'), document.createTextNode(t('连接断开，正在重连…')));
  });

  const refresh = debounce(() => loadBoard(), 350);
  for (const evt of ['board:new', 'board:update', 'board:remove', 'user:update']) {
    source.addEventListener(evt, refresh);
  }
  // 上下线变动比较频繁，合并得久一点，避免一直重绘
  source.addEventListener('presence', debounce(() => loadBoard(), 1500));
}

function connectPostStream(postId) {
  if (state.postSource) state.postSource.close();
  const source = new EventSource(`/api/posts/${postId}/stream`);
  state.postSource = source;

  source.addEventListener('message', (e) => {
    const payload = JSON.parse(e.data);
    if (!state.detail || state.detail.id !== postId) return;
    state.detail.messages.push(payload.message);
    const log = $('#chatLog');
    if (log) {
      const stick = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
      log.append(messageNode(payload.message));
      if (stick) scrollChatToEnd();
    }
  });
  source.addEventListener('post:update', () => refreshDetail());
  source.addEventListener('post:locked', () => refreshDetail());
  source.addEventListener('presence', debounce(() => refreshDetail(), 1200));
  source.addEventListener('post:removed', () => { toast(t('发起人删除了这个帖子')); closeDetail(); });
}

function debounce(fn, wait) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

/* ------------------------------------------------------------ 发起搭子 */

function renderCreatePickers() {
  const cats = $('#catPicker');
  cats.replaceChildren();
  for (const cat of state.meta.categories) {
    cats.append(el('button', {
      class: 'pick-chip', type: 'button',
      'aria-pressed': String(state.draft.category === cat.id),
      text: `${cat.emoji} ${L(cat)}`,
      onclick: () => { state.draft.category = cat.id; renderCreatePickers(); },
    }));
  }

  const opts = $('#optPicker');
  opts.replaceChildren();
  for (const preset of state.meta.presetOptions) {
    const on = state.draft.options.some((o) => o.label === preset.label);
    opts.append(el('button', {
      class: 'pick-chip', type: 'button', 'aria-pressed': String(on),
      text: `${preset.emoji} ${L(preset)}`,
      onclick: () => {
        if (on) state.draft.options = state.draft.options.filter((o) => o.label !== preset.label);
        else if (state.draft.options.length < state.meta.limits.optionsPerPost) state.draft.options.push({ ...preset });
        else toast(t('最多选 {n} 个项目', { n: state.meta.limits.optionsPerPost }));
        renderCreatePickers();
      },
    }));
  }

  const picked = $('#pickedOpts');
  picked.replaceChildren();
  for (const opt of state.draft.options) {
    picked.append(el('button', {
      class: 'pick-chip', type: 'button', text: `${opt.emoji} ${L(opt)} ✕`,
      onclick: () => {
        state.draft.options = state.draft.options.filter((o) => o.label !== opt.label);
        renderCreatePickers();
      },
    }));
  }
}

function openCreate() {
  $('#createErr').textContent = '';
  $('#createOverlay').hidden = false;
  renderCreatePickers();
  $('#createForm').querySelector('input[name=title]').focus();
}

async function submitCreate(e) {
  e.preventDefault();
  const form = e.target;
  const data = Object.fromEntries(new FormData(form).entries());
  if (state.draft.options.length === 0) {
    $('#createErr').textContent = t('至少选一个想一起做的项目');
    return;
  }
  const btn = form.querySelector('button[type=submit]');
  btn.disabled = true;
  try {
    const result = await api('/api/posts', {
      method: 'POST',
      body: JSON.stringify({ ...data, category: state.draft.category, options: state.draft.options }),
    });
    form.reset();
    state.draft.options = [];
    $('#createOverlay').hidden = true;
    await loadBoard();
    openDetail(result.post.id);
    toast(t('发布成功，等人来搭 🎉'));
  } catch (err) {
    $('#createErr').textContent = err.message;
  } finally {
    btn.disabled = false;
  }
}

/* ------------------------------------------------------------ 登录 / 注册 */

function openAuth(mode = 'login') {
  state.authMode = mode;
  $('#authErr').textContent = '';
  $('#authOverlay').hidden = false;
  renderAuthMode();
  $('#authForm').querySelector('input[name=username]').focus();
}

function renderAuthMode() {
  const isLogin = state.authMode === 'login';
  $('#tabLogin').setAttribute('aria-selected', String(isLogin));
  $('#tabRegister').setAttribute('aria-selected', String(!isLogin));
  $('#authSubmit').textContent = isLogin ? t('登录') : t('注册');
  $('#authForm').querySelector('input[name=password]')
    .setAttribute('autocomplete', isLogin ? 'current-password' : 'new-password');

  const rule = state.meta.usernameRule;
  $('#authSub').textContent = isLogin
    ? t('登录后可以在任何设备上找回你的帖子和身份')
    : t('注册会把账号绑定到你当前的身份上');
  $('#authHint').textContent = isLogin ? '' : t(
    '用户名 {min}-{max} 位，密码至少 {pmin} 位。注册不会新建一个人：你现在的昵称 {nick}、已发的帖子和聊天记录都会保留。',
    { min: rule.min, max: rule.max, pmin: rule.passwordMin, nick: state.me ? state.me.nick : '' },
  );
}

async function submitAuth(e) {
  e.preventDefault();
  const form = e.target;
  const data = Object.fromEntries(new FormData(form).entries());
  const btn = $('#authSubmit');
  btn.disabled = true;
  try {
    const endpoint = state.authMode === 'login' ? '/api/auth/login' : '/api/auth/register';
    const result = await api(endpoint, { method: 'POST', body: JSON.stringify(data) });
    state.me = result.user;
    form.reset();
    $('#authOverlay').hidden = true;
    renderMe();
    toast(state.authMode === 'login'
      ? t('欢迎回来，{nick}', { nick: result.user.nick })
      : t('注册成功，身份已绑定'));
    loadBoard();
  } catch (err) {
    $('#authErr').textContent = err.message;
  } finally {
    btn.disabled = false;
  }
}

async function logout() {
  if (!confirm(t('退出后会回到一个全新的匿名身份，之前的帖子仍属于原账号。确定？'))) return;
  try {
    const result = await api('/api/auth/logout', { method: 'POST' });
    state.me = result.user;
    renderMe();
    $('#meOverlay').hidden = true;
    toast(t('已退出登录'));
    loadBoard();
  } catch (err) { toast(err.message); }
}

async function changePassword() {
  const oldPassword = prompt(t('请输入当前密码：'));
  if (!oldPassword) return;
  const newPassword = prompt(t('请输入新密码（至少 {n} 位）：', { n: state.meta.usernameRule.passwordMin }));
  if (!newPassword) return;
  try {
    await api('/api/auth/password', {
      method: 'POST', body: JSON.stringify({ oldPassword, newPassword }),
    });
    toast(t('密码已修改'));
  } catch (err) { toast(err.message); }
}

function renderAccountBox() {
  const box = $('#accountBox');
  if (!box || !state.me) return;
  box.replaceChildren();

  if (state.me.username) {
    box.append(
      el('h3', {
        text: state.me.admin
          ? t('已登录：{name}（管理员）', { name: state.me.username })
          : t('已登录：{name}', { name: state.me.username }),
      }),
      el('p', { text: t('账号和这个身份是绑定的，换设备用账号密码登录即可拿回全部内容。') }),
      el('div', { class: 'account-actions' }, [
        el('button', { class: 'ghost-btn', type: 'button', text: t('修改密码'), onclick: changePassword }),
        el('button', { class: 'ghost-btn danger', type: 'button', text: t('退出登录'), onclick: logout }),
      ]),
    );
  } else {
    box.append(
      el('h3', { text: t('还没有注册账号') }),
      el('p', {
        text: state.meta.requireLogin
          ? t('本站已开启「登录后才能发言」，注册后才能发帖和聊天。')
          : t('不注册也能正常用。注册的好处是换设备时用账号密码就能拿回身份，比记一串口令方便。'),
      }),
      el('div', { class: 'account-actions' }, [
        el('button', {
          class: 'primary-btn', type: 'button', text: t('注册账号'),
          onclick: () => { $('#meOverlay').hidden = true; openAuth('register'); },
        }),
        el('button', {
          class: 'ghost-btn', type: 'button', text: t('已有账号，去登录'),
          onclick: () => { $('#meOverlay').hidden = true; openAuth('login'); },
        }),
      ]),
    );
  }
}

/* ------------------------------------------------------------ 管理后台 */

async function openAdmin() {
  state.adminTab = 'users';
  $('#adminOverlay').hidden = false;
  $('#adminSearch').value = '';
  await refreshAdmin();
}

async function refreshAdmin() {
  const isUsers = state.adminTab === 'users';
  $('#tabUsers').setAttribute('aria-selected', String(isUsers));
  $('#tabPosts').setAttribute('aria-selected', String(!isUsers));
  $('#adminSearch').hidden = !isUsers;

  try {
    const overview = await api('/api/admin/overview');
    const s = overview.stats;
    $('#adminStats').replaceChildren(...[
      ['用户', s.users], ['已注册', s.registered], ['在线', s.online],
      ['帖子', s.posts], ['已锁定', s.locked], ['消息', s.messages], ['已封禁', s.banned],
    ].map(([label, value]) => el('div', { class: 'stat' }, [
      el('b', { text: String(value) }),
      el('span', { text: t(label) }),
    ])));

    if (isUsers) await renderAdminUsers();
    else await renderAdminPosts();
  } catch (err) { toast(err.message); }
}

async function renderAdminUsers() {
  const q = $('#adminSearch').value.trim();
  const data = await api(`/api/admin/users?q=${encodeURIComponent(q)}`);
  const list = $('#adminList');
  list.replaceChildren();
  if (!data.users.length) {
    list.append(el('div', { class: 'empty-col', text: t('没有匹配的用户') }));
    return;
  }
  for (const u of data.users) {
    const row = el('div', { class: `admin-row${u.banned ? ' banned' : ''}` }, [
      avatarWithPresence(u, u.online),
      el('div', { class: 'grow' }, [
        el('b', { text: u.nick }),
        el('small', {
          text: `#${u.tag}${u.username ? ` · @${u.username}` : ` · ${t('匿名')}`} · ${t('{n} 帖', { n: u.posts })}`,
        }),
      ]),
      u.admin ? el('span', { class: 'badge lock', text: t('管理员') }) : null,
      u.banned ? el('span', { class: 'badge done', text: t('已封禁') }) : null,
    ]);

    if (u.uid !== state.me.uid) {
      row.append(el('button', {
        class: 'ghost-btn', type: 'button', text: u.banned ? t('解封') : t('封禁'),
        onclick: async () => {
          if (!u.banned && !confirm(t('封禁 {nick}？封禁后 ta 无法发帖和发言。', { nick: u.nick }))) return;
          try {
            await api(`/api/admin/users/${u.uid}/ban`, {
              method: 'POST', body: JSON.stringify({ banned: !u.banned }),
            });
            refreshAdmin();
          } catch (err) { toast(err.message); }
        },
      }));
      row.append(el('button', {
        class: 'ghost-btn', type: 'button', text: u.admin ? t('取消管理员') : t('设为管理员'),
        onclick: async () => {
          try {
            await api(`/api/admin/users/${u.uid}/role`, {
              method: 'POST', body: JSON.stringify({ role: u.admin ? 'user' : 'admin' }),
            });
            refreshAdmin();
          } catch (err) { toast(err.message); }
        },
      }));
    }
    list.append(row);
  }
}

async function renderAdminPosts() {
  const data = await api('/api/admin/posts');
  const list = $('#adminList');
  list.replaceChildren();
  if (!data.posts.length) {
    list.append(el('div', { class: 'empty-col', text: t('还没有帖子') }));
    return;
  }
  for (const p of data.posts) {
    const stateMeta = state.meta.states.find((s) => s.id === p.state);
    list.append(el('div', { class: 'admin-row' }, [
      el('div', { class: 'grow' }, [
        el('b', { text: p.title }),
        el('small', { text: `${p.host.nick} #${p.host.tag} · ${p.memberCount} 人 · ${p.messageCount} 条消息 · ${timeAgo(p.updatedAt)}` }),
      ]),
      stateMeta ? el('span', { class: `badge ${p.state}`, text: L(stateMeta) }) : null,
      el('button', {
        class: 'ghost-btn', type: 'button', text: t('查看'),
        onclick: () => { $('#adminOverlay').hidden = true; openDetail(p.id); },
      }),
      el('button', {
        class: 'ghost-btn', type: 'button', text: p.locked ? t('解锁') : t('锁定'),
        onclick: async () => {
          try {
            await api(`/api/posts/${p.id}`, {
              method: 'PATCH', body: JSON.stringify({ locked: !p.locked }),
            });
            refreshAdmin();
          } catch (err) { toast(err.message); }
        },
      }),
      el('button', {
        class: 'ghost-btn danger', type: 'button', text: t('删除'),
        onclick: async () => {
          if (!confirm(t('删除「{title}」？聊天记录也会一起消失。', { title: p.title }))) return;
          try {
            await api(`/api/posts/${p.id}`, { method: 'DELETE' });
            toast(t('已删除'));
            refreshAdmin();
            loadBoard();
          } catch (err) { toast(err.message); }
        },
      }),
    ]));
  }
}

/* -------------------------------------------------------------- 我的身份 */

function renderMe() {
  if (!state.me) return;
  $('#meAvatar').textContent = state.me.emoji;
  $('#meAvatar').style.background = state.me.color;
  $('#meNick').textContent = state.me.nick;
  // 管理后台入口和登录按钮都跟着当前身份走
  $('#adminBtn').hidden = !state.me.admin;
  $('#authBtn').hidden = Boolean(state.me.username);
  renderAccountBox();
}

const EMOJI_CHOICES = ['🙂', '🏀', '🏸', '🎬', '🍜', '📚', '🎮', '🧋', '🐱', '🐶', '🐼', '🦊', '🐧', '🎧', '🚴', '⛰️', '🎤', '🧃'];
const COLOR_CHOICES = ['#ff8fab', '#ffb703', '#8ecae6', '#95d5b2', '#c8b6ff', '#ffd6a5', '#a0c4ff', '#9bf6ff', '#caffbf', '#ffc6ff'];

function openMe() {
  $('#meErr').textContent = '';
  $('#meOverlay').hidden = false;
  const draft = { ...state.me };

  const preview = $('#identityPreview');
  const paint = () => {
    preview.replaceChildren(
      avatar(draft),
      el('div', { class: 'who' }, [
        el('strong', { text: draft.nick }),
        el('span', { text: `#${draft.tag} · ${t('这个编号永远跟着你')}` }),
      ]),
    );
  };
  paint();

  const nickInput = $('#meForm').querySelector('input[name=nick]');
  nickInput.value = state.me.nick;
  nickInput.oninput = () => { draft.nick = nickInput.value || state.me.nick; paint(); };

  const emojis = $('#emojiPicker');
  emojis.replaceChildren();
  for (const emo of EMOJI_CHOICES) {
    emojis.append(el('button', {
      class: 'pick-chip', type: 'button', text: emo,
      'aria-pressed': String(draft.emoji === emo),
      onclick: () => {
        draft.emoji = emo; paint();
        $$('button', emojis).forEach((b) => b.setAttribute('aria-pressed', String(b.textContent === emo)));
      },
    }));
  }

  const colors = $('#colorPicker');
  colors.replaceChildren();
  for (const color of COLOR_CHOICES) {
    colors.append(el('button', {
      class: 'color-dot', type: 'button', style: { background: color },
      'aria-pressed': String(draft.color === color), 'aria-label': color, 'data-color': color,
      onclick: () => {
        draft.color = color;
        paint();
        $$('button', colors).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.color === color)));
      },
    }));
  }

  const emailInput = $('#meForm').querySelector('input[name=email]');
  const notifyInput = $('#meForm').querySelector('input[name=notifyEmail]');
  emailInput.value = state.me.email || '';
  notifyInput.checked = state.me.notifyEmail !== false;
  const rule = state.meta.notifyRule;
  $('#notifyHint').textContent = state.meta.mailEnabled
    ? t('有人在你的帖子里待满 {min} 分钟、并且发过至少 {msg} 条消息时，给你发一封提醒邮件。每人每帖只提醒一次，邮箱不会公开给任何人。',
      { min: rule.dwellMinutes, msg: rule.minMessages })
    : t('站点还没配置发信服务，填了也暂时收不到邮件。规则是：有人在你的帖子里待满 {min} 分钟且发过 {msg} 条以上消息就提醒你。',
      { min: rule.dwellMinutes, msg: rule.minMessages });

  $('#meForm').onsubmit = async (e) => {
    e.preventDefault();
    try {
      const data = await api('/api/me', {
        method: 'PATCH',
        body: JSON.stringify({
          nick: nickInput.value,
          emoji: draft.emoji,
          color: draft.color,
          email: emailInput.value,
          notifyEmail: notifyInput.checked,
        }),
      });
      state.me = data.user;
      renderMe();
      $('#meOverlay').hidden = true;
      toast(t('身份已更新，全站同步'));
      loadBoard();
      if (state.detail) refreshDetail();
    } catch (err) {
      $('#meErr').textContent = err.message;
    }
  };
}

async function setupIdentity() {
  const data = await api('/api/me');
  state.me = data.user;
  renderMe();
  if (data.fresh && data.recoveryCode) {
    // 首次进站：把身份口令存在本地，方便用户随时查看/换设备找回。
    try { localStorage.setItem('dazi.recovery', data.recoveryCode); } catch (_) { /* 隐私模式 */ }
    toast(t('欢迎，{nick}！你的身份已自动生成', { nick: state.me.nick }));
  }
}

/* ------------------------------------------------------------------ 启动 */

function bindUi() {
  $('#createBtn').onclick = openCreate;
  $('#meBtn').onclick = openMe;
  $('#createForm').onsubmit = submitCreate;

  $('#authBtn').onclick = () => openAuth('login');
  $('#authForm').onsubmit = submitAuth;
  $('#tabLogin').onclick = () => { state.authMode = 'login'; $('#authErr').textContent = ''; renderAuthMode(); };
  $('#tabRegister').onclick = () => { state.authMode = 'register'; $('#authErr').textContent = ''; renderAuthMode(); };

  $('#langBtn').onclick = () => {
    I18N.set(I18N.get() === 'zh' ? 'en' : 'zh');
    applyLanguage();
  };

  $('#adminBtn').onclick = openAdmin;
  $('#tabUsers').onclick = () => { state.adminTab = 'users'; refreshAdmin(); };
  $('#tabPosts').onclick = () => { state.adminTab = 'posts'; refreshAdmin(); };
  $('#adminSearch').addEventListener('input', debounce(() => {
    if (state.adminTab === 'users') renderAdminUsers().catch((err) => toast(err.message));
  }, 280));

  $('#addOpt').onclick = () => {
    const input = $('#customOpt');
    const label = input.value.trim();
    if (!label) return;
    if (state.draft.options.length >= state.meta.limits.optionsPerPost) return toast(t('选项已满'));
    if (!state.draft.options.some((o) => o.label === label)) state.draft.options.push({ label, emoji: '✨' });
    input.value = '';
    renderCreatePickers();
  };
  $('#customOpt').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); $('#addOpt').click(); }
  });

  $('#mineToggle').onclick = (e) => {
    state.mineOnly = !state.mineOnly;
    e.currentTarget.setAttribute('aria-pressed', String(state.mineOnly));
    loadBoard();
  };

  $('#filterBtn').onclick = (e) => { e.stopPropagation(); toggleFilterPanel(); };
  $('#filterPanel').addEventListener('click', (e) => e.stopPropagation());
  $('#resetFilter').onclick = () => {
    state.sort = 'active';
    state.stateFilter = '';
    loadBoard();
    toggleFilterPanel(false);
  };
  document.addEventListener('click', () => toggleFilterPanel(false));

  $('#search').addEventListener('input', debounce((e) => {
    state.query = e.target.value.trim();
    loadBoard();
  }, 280));

  $('#showRecovery').onclick = async () => {
    if (!confirm(t('生成新口令后，旧口令立即失效。继续？'))) return;
    try {
      const data = await api('/api/me/recovery', { method: 'POST' });
      $('#recoveryCode').textContent = data.recoveryCode;
      try { localStorage.setItem('dazi.recovery', data.recoveryCode); } catch (_) { /* ignore */ }
      toast(t('请把这串口令记下来'));
    } catch (err) { toast(err.message); }
  };

  $('#restoreBtn').onclick = async () => {
    const code = prompt(t('粘贴你在另一台设备上的身份口令：'));
    if (!code) return;
    try {
      const data = await api('/api/session/restore', { method: 'POST', body: JSON.stringify({ code }) });
      state.me = data.user;
      renderMe();
      toast(t('欢迎回来，{nick}', { nick: data.user.nick }));
      $('#meOverlay').hidden = true;
      loadBoard();
    } catch (err) { toast(err.message); }
  };

  for (const overlay of $$('.overlay')) {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay || e.target.hasAttribute('data-close')) {
        if (overlay.id === 'detailOverlay') closeDetail();
        else overlay.hidden = true;
      }
    });
  }
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!$('#filterPanel').hidden) return toggleFilterPanel(false);
    if (!$('#detailOverlay').hidden) return closeDetail();
    for (const overlay of $$('.overlay')) overlay.hidden = true;
  });

  try {
    const saved = localStorage.getItem('dazi.recovery');
    if (saved) $('#recoveryCode').textContent = saved;
  } catch (_) { /* ignore */ }
}

/** 切换语言后把静态文案和所有动态渲染的部分都刷一遍。 */
function applyLanguage() {
  I18N.applyStatic();
  document.title = t('校园搭子*莫纳什 · 找到一起干的人');
  $('#langBtn').textContent = I18N.get() === 'zh' ? '中 / EN' : 'EN / 中';
  renderFilters();
  renderFeed();
  renderFilterPanel();
  renderOnlineNow();
  renderMe();
  renderCreatePickers();
  if (state.detail) renderDetail();
  if (!$('#authOverlay').hidden) renderAuthMode();
  if (!$('#adminOverlay').hidden) refreshAdmin();
}

async function main() {
  try {
    state.meta = await api('/api/meta');
    await setupIdentity();
    bindUi();
    applyLanguage();
    renderFilters();
    await loadBoard();
    connectBoardStream();
    setInterval(() => { if (!state.detail) loadBoard(); }, 60_000);

    // 邮件提醒里的链接形如 /?post=xxxx，直接把帖子打开
    const target = new URLSearchParams(location.search).get('post');
    if (target) openDetail(target);
  } catch (err) {
    document.body.append(el('div', { class: 'locked-note' }, [
      el('div', { class: 'big', text: '😵' }),
      el('h3', { text: t('加载失败') }),
      el('p', { text: err.message }),
    ]));
  }
}

main();
