/* 中英切换。用中文原文当 key：漏翻的地方回落成中文，不会变成空白或 undefined。 */
'use strict';

const I18N = (() => {
  const EN = {
    /* 顶栏与页脚 */
    '校园搭子': 'Campus Buddy',
    '*莫纳什': '*Monash',
    '校园搭子*莫纳什 · 找到一起干的人': 'Campus Buddy*Monash — find your crew',
    '离线': 'Offline',
    '一张卡片，找到一起干的人': 'One card away from your next crew',
    '搜标题 / 校区 / 项目…': 'Search title / campus / activity…',
    '只看我的': 'Mine only',
    '＋ 发起搭子': '+ New meetup',
    '🛡️ 管理后台': '🛡️ Admin',
    '登录 / 注册': 'Log in / Sign up',
    '我的身份': 'My identity',
    '实时连接中…': 'Connecting…',
    '实时同步中': 'Live',
    '连接断开，正在重连…': 'Disconnected, reconnecting…',
    '免注册 · 身份由服务器签发并长期保持一致 · 帖子可上锁':
      'No sign-up needed · your identity is server-issued and stays consistent · posts can be locked',
    '{n} 人在线': '{n} online',

    /* 筛选 */
    '筛选': 'Filter',
    '排序': 'Sort',
    '招募状态': 'Status',
    '恢复默认': 'Reset',
    '全部': 'All',
    '🌐 全部': '🌐 All',

    /* 卡片 */
    '需暗号': 'Passcode',
    '我发起': 'Mine',
    '已加入': 'Joined',
    '{n} 在线': '{n} online',
    '{count}/{cap} 人': '{count}/{cap} people',
    '刚刚': 'just now',
    '{n} 分钟前': '{n} min ago',
    '{n} 小时前': '{n} h ago',
    '{n} 天前': '{n} d ago',
    '还没有人发起搭子局': 'No meetups yet',
    '点右上角「发起搭子」，当第一个吧': 'Hit “New meetup” in the top right and be the first',
    '没有符合条件的搭子局': 'No meetups match your filters',
    '换个分类或把筛选条件放宽试试': 'Try another category or loosen the filters',

    /* 发帖表单 */
    '发起一个搭子局': 'Start a meetup',
    '勾选多个想做的项目，报名的人各自选自己想去的那个':
      'Pick several activities — everyone who joins votes for the one they want',
    '标题': 'Title',
    '例：周三晚上东区球场，缺俩人': 'e.g. Wed night basketball, need 2 more',
    '分类': 'Category',
    '想一起做什么（可多选，报名者再投票）': 'What do you want to do? (multi-select, joiners vote)',
    '自定义项目，如「爬山」': 'Custom activity, e.g. “Hiking”',
    '添加': 'Add',
    '时间': 'Time',
    '地点': 'Place',
    '人数上限': 'Max people',
    '校区 / 学校': 'Campus / school',
    '例：××大学 紫金港校区': 'e.g. Monash University, Clayton campus',
    '补充说明': 'Notes',
    '装备、水平、AA 方式、集合点…': 'Gear, skill level, cost splitting, meeting point…',
    '取消': 'Cancel',
    '发布': 'Publish',
    '至少选一个想一起做的项目': 'Pick at least one activity',
    '选项已满': 'No more options allowed',
    '最多选 {n} 个项目': 'You can pick at most {n} activities',
    '发布成功，等人来搭 🎉': 'Published! Now wait for people to join 🎉',

    /* 帖子详情 */
    '说明': 'Description',
    '信息': 'Details',
    '校区': 'Campus',
    '人数': 'People',
    '想一起做什么（点一下改选）': 'Activities (tap to change your pick)',
    '备选项目': 'Activities on offer',
    '{n} 人': '{n}',
    '成员 {n}': 'Members ({n})',
    '成员 {n} · {online} 人在线': 'Members ({n}) · {online} online',
    '发起人': 'Organiser',
    '管理员': 'Admin',
    '在房间里': 'In the room',
    '移出': 'Remove',
    '操作': 'Actions',
    '＋ 我要加入': '+ Join',
    '退出这个局': 'Leave',
    '🔒 锁住帖子': '🔒 Lock post',
    '🔓 解锁帖子': '🔓 Unlock post',
    '🎉 标记完成': '🎉 Mark finished',
    '↩︎ 重新开放': '↩︎ Reopen',
    '删除': 'Delete',
    '查看': 'View',
    '锁定': 'Lock',
    '解锁': 'Unlock',
    '由 {nick} 发起': 'by {nick}',
    '当前已锁定：只有成员，或知道暗号的人才能进来。':
      'Locked: only members, or people with the passcode, can enter.',
    '当前已锁定：只有已加入的成员能进来。': 'Locked: only members who already joined can enter.',
    '加入成功，去聊两句吧': 'Joined! Say hi in the chat',
    '把 {nick} 移出这个局？': 'Remove {nick} from this meetup?',
    '删除后聊天记录也会消失，确定？': 'The chat history will be deleted too. Are you sure?',
    '已删除': 'Deleted',
    '发起人删除了这个帖子': 'The organiser deleted this post',

    /* 锁帖 */
    '这个帖子被发起人锁上了': 'This post is locked by its organiser',
    '发起人设置了进入暗号。知道暗号的话，在下面输入就能进来一起聊。':
      'The organiser set a passcode. Enter it below to come in.',
    '锁定之后只有已经加入的成员能看到内容和聊天。可以先私下问问发起人。':
      'Once locked, only members can see the content and chat. Try asking the organiser.',
    '输入暗号': 'Enter passcode',
    '进入': 'Enter',
    '暗号正确，欢迎加入！': 'Correct! Welcome in',
    '锁住之后，没加入的人看不到内容也进不来。\n\n可选：设一个暗号，知道暗号的人仍可进入（留空则完全不让新人进）。':
      'Once locked, people who have not joined cannot see or enter.\n\nOptional: set a passcode so people who know it can still get in (leave blank to close it completely).',
    '已锁定，凭暗号可进 🔒': 'Locked — passcode required 🔒',
    '已锁定，别人进不来了 🔒': 'Locked — nobody else can get in 🔒',
    '已解锁': 'Unlocked',

    /* 聊天 */
    '说点什么…（Enter 发送）': 'Say something… (Enter to send)',
    '这个局已经结束了': 'This meetup has finished',
    '发送': 'Send',

    /* 身份 */
    '不用注册、不用密码。身份由服务器签发，全站统一。':
      'No sign-up, no password. Your identity is issued by the server and stays the same everywhere.',
    '昵称（全站唯一）': 'Nickname (unique site-wide)',
    '头像': 'Avatar',
    '底色': 'Colour',
    '提醒邮箱（可选）': 'Notification email (optional)',
    '用来收「有人认真看了你的帖子」提醒': 'To receive “someone is really interested” alerts',
    '开启邮件提醒': 'Enable email alerts',
    '保存': 'Save',
    '换设备也保持同一个身份': 'Keep the same identity on another device',
    '身份口令相当于你的「随身学生证」。在别的浏览器粘贴它，就还是同一个你。':
      'Your identity code works like a student card. Paste it in another browser and you are still you.',
    '生成新的身份口令': 'Generate a new identity code',
    '用口令找回身份': 'Restore identity with a code',
    '生成新口令后，旧口令立即失效。': 'Generating a new code invalidates the old one immediately.',
    '这个编号永远跟着你': 'this tag stays with you forever',
    '身份已更新，全站同步': 'Identity updated everywhere',
    '欢迎，{nick}！你的身份已自动生成': 'Welcome, {nick}! An identity has been created for you',
    '欢迎回来，{nick}': 'Welcome back, {nick}',
    '生成新口令后，旧口令立即失效。继续？':
      'Generating a new code invalidates the old one immediately. Continue?',
    '请把这串口令记下来': 'Write this code down somewhere safe',
    '粘贴你在另一台设备上的身份口令：': 'Paste the identity code from your other device:',
    '有人在你的帖子里待满 {min} 分钟、并且发过至少 {msg} 条消息时，给你发一封提醒邮件。每人每帖只提醒一次，邮箱不会公开给任何人。':
      'When someone spends {min} minutes in your post and sends at least {msg} message, you get an email. Once per person per post; your address is never shown to anyone.',
    '站点还没配置发信服务，填了也暂时收不到邮件。规则是：有人在你的帖子里待满 {min} 分钟且发过 {msg} 条以上消息就提醒你。':
      'Email sending is not configured on this site yet, so alerts will not arrive. The rule: someone spends {min} minutes in your post and sends at least {msg} message.',

    /* 账号 */
    '登录': 'Log in',
    '注册': 'Sign up',
    '用户名': 'Username',
    '密码': 'Password',
    '3-20 位，中英文均可': '3-20 characters',
    '至少 6 位': 'At least 6 characters',
    '登录后可以在任何设备上找回你的帖子和身份':
      'Log in to get your posts and identity back on any device',
    '注册会把账号绑定到你当前的身份上': 'Signing up binds an account to your current identity',
    '用户名 {min}-{max} 位，密码至少 {pmin} 位。注册不会新建一个人：你现在的昵称 {nick}、已发的帖子和聊天记录都会保留。':
      'Username {min}-{max} characters, password at least {pmin}. Signing up does not create a new person: your nickname {nick}, your posts and your chat history all stay.',
    '注册成功，身份已绑定': 'Signed up — account bound to your identity',
    '已登录：{name}': 'Logged in as {name}',
    '已登录：{name}（管理员）': 'Logged in as {name} (admin)',
    '账号和这个身份是绑定的，换设备用账号密码登录即可拿回全部内容。':
      'The account is bound to this identity. Log in elsewhere to get everything back.',
    '修改密码': 'Change password',
    '退出登录': 'Log out',
    '还没有注册账号': 'No account yet',
    '本站已开启「登录后才能发言」，注册后才能发帖和聊天。':
      'This site requires an account before you can post or chat.',
    '不注册也能正常用。注册的好处是换设备时用账号密码就能拿回身份，比记一串口令方便。':
      'You can use the site without an account. Signing up just makes it easier to get your identity back on another device.',
    '注册账号': 'Create an account',
    '已有账号，去登录': 'I already have an account',
    '退出后会回到一个全新的匿名身份，之前的帖子仍属于原账号。确定？':
      'Logging out gives you a fresh anonymous identity; your posts stay with the old account. Continue?',
    '已退出登录': 'Logged out',
    '请输入当前密码：': 'Enter your current password:',
    '请输入新密码（至少 {n} 位）：': 'Enter a new password (at least {n} characters):',
    '密码已修改': 'Password changed',

    /* 管理后台 */
    '封禁用户、设置管理员、下架帖子': 'Ban users, appoint admins, take posts down',
    '用户': 'Users',
    '帖子': 'Posts',
    '搜昵称 / 用户名 / ID': 'Search nickname / username / ID',
    '已注册': 'Registered',
    '在线': 'Online',
    '已锁定': 'Locked',
    '消息': 'Messages',
    '封禁': 'Ban',
    '解封': 'Unban',
    '已封禁': 'Banned',
    '设为管理员': 'Make admin',
    '取消管理员': 'Remove admin',
    '匿名': 'anonymous',
    '{n} 帖': '{n} posts',
    '没有匹配的用户': 'No matching users',
    '还没有帖子': 'No posts yet',
    '封禁 {nick}？封禁后 ta 无法发帖和发言。':
      'Ban {nick}? They will not be able to post or chat.',
    '删除「{title}」？聊天记录也会一起消失。':
      'Delete “{title}”? The chat history goes with it.',

    /* 其它 */
    '关闭': 'Close',
    '加载失败': 'Failed to load',
    '{n} 人在线（全站）': '{n} online',
  };

  // 优先用上次选择；没选过就看浏览器语言（莫纳什这类环境里浏览器多半是英文）
  let lang = 'zh';
  try {
    const saved = localStorage.getItem('dazi.lang');
    if (saved === 'zh' || saved === 'en') lang = saved;
    else lang = (navigator.language || 'zh').toLowerCase().startsWith('zh') ? 'zh' : 'en';
  } catch (_) {
    lang = 'zh';
  }

  /** 翻译并做 {占位符} 替换。找不到翻译时回落中文原文。 */
  function t(zh, vars) {
    let out = lang === 'en' && EN[zh] ? EN[zh] : zh;
    if (vars) {
      for (const [key, value] of Object.entries(vars)) {
        out = out.split(`{${key}}`).join(String(value));
      }
    }
    return out;
  }

  /** meta 里的分类/状态/排序等，服务端同时给了中英两份。 */
  function label(item) {
    if (!item) return '';
    return lang === 'en' && item.labelEn ? item.labelEn : item.label;
  }

  function hint(item) {
    if (!item) return '';
    return lang === 'en' && item.hintEn ? item.hintEn : item.hint;
  }

  /**
   * 翻译页面上的静态文案。
   * 首次遍历时把中文原文记在节点上，之后来回切换都以它为准，
   * 这样切回中文不会因为「英文查不到」而卡住。
   */
  function applyStatic(root = document.body) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const node of nodes) {
      if (node.__zh === undefined) {
        if (!node.nodeValue.trim()) continue;
        node.__zh = node.nodeValue;
      }
      const raw = node.__zh;
      const trimmed = raw.trim();
      const translated = t(trimmed);
      node.nodeValue = raw.replace(trimmed, translated);
    }

    for (const attr of ['placeholder', 'title', 'aria-label']) {
      for (const el of root.querySelectorAll(`[${attr}]`)) {
        const key = `__zh_${attr}`;
        if (el[key] === undefined) el[key] = el.getAttribute(attr);
        el.setAttribute(attr, t(el[key]));
      }
    }
    document.documentElement.lang = lang === 'en' ? 'en' : 'zh-CN';
  }

  function get() { return lang; }

  function set(next) {
    lang = next === 'en' ? 'en' : 'zh';
    try { localStorage.setItem('dazi.lang', lang); } catch (_) { /* 隐私模式 */ }
  }

  return { t, label, hint, applyStatic, get, set };
})();
