'use strict';

/**
 * 「有人认真看了你的帖子」提醒。
 *
 * 触发条件（三个都满足才发）：
 *   1. 在帖子房间里累计停留 >= 30 分钟
 *   2. 在帖子里至少发过 1 条消息
 *   3. 不是发起人本人
 * 每个人在每个帖子里只提醒一次（visits[uid].notified）。
 *
 * 发起人必须自己在「我的身份」里填了邮箱才会收到——免注册不等于能拿到联系方式。
 * 没配 SMTP 时静默跳过，站内的「新访客」标记照常工作。
 */

const store = require('./store');
const mailer = require('./mailer');
const identity = require('./identity');

const DWELL_THRESHOLD_MS = Number(process.env.DAZI_NOTIFY_DWELL_MS || 30 * 60 * 1000);
const MIN_MESSAGES = Number(process.env.DAZI_NOTIFY_MIN_MESSAGES || 1);

function siteUrl() {
  return (process.env.DAZI_SITE_URL || '').replace(/\/+$/, '');
}

function formatDuration(ms) {
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  return `${hours} 小时 ${minutes % 60} 分钟`;
}

function buildEmail(post, host, visitor, visit) {
  const link = siteUrl() ? `${siteUrl()}/?post=${post.id}` : '（站点地址未配置）';
  const option = post.options.find((o) => o.id === (post.members[visitor.uid] || {}).optionId);
  const joined = Boolean(post.members[visitor.uid]);

  const lines = [
    `${host.nick}，你好：`,
    '',
    `有人在认真看你的搭子局「${post.title}」。`,
    '',
    `  访客　：${visitor.nick} #${identity.shortId(visitor.uid)}`,
    `  停留　：${formatDuration(visit.dwellMs)}`,
    `  发言　：${visit.messages} 条`,
    `  状态　：${joined ? `已加入，想一起「${option ? option.label : '——'}」` : '还没点加入，只是在里面聊'}`,
    '',
    `去看看：${link}`,
    '',
    '——',
    '校园搭子 · 你可以在「我的身份」里随时关掉这类提醒。',
  ];
  return {
    subject: `【校园搭子】${visitor.nick} 在「${post.title}」里待了 ${formatDuration(visit.dwellMs)}`,
    text: lines.join('\n'),
  };
}

/**
 * 检查一个帖子里有没有该提醒的访客。
 * @returns {Array} 本次触发的提醒（用于站内展示和测试断言）
 */
function checkPost(post) {
  const db = store.data();
  const host = db.users[post.hostId];
  if (!host || !post.visits) return [];

  const fired = [];
  for (const uid of Object.keys(post.visits)) {
    if (uid === post.hostId) continue;
    const visit = post.visits[uid];
    if (visit.notified) continue;
    if (visit.dwellMs < DWELL_THRESHOLD_MS) continue;
    if (visit.messages < MIN_MESSAGES) continue;

    const visitor = db.users[uid];
    if (!visitor) continue;

    visit.notified = true;
    visit.notifiedAt = Date.now();
    fired.push({ postId: post.id, uid, dwellMs: visit.dwellMs, messages: visit.messages });

    if (!host.email || host.notifyEmail === false) continue;

    const mail = buildEmail(post, host, visitor, visit);
    mailer
      .send({ to: host.email, subject: mail.subject, text: mail.text })
      .then((result) => {
        if (result.sent) console.log(`[notify] 已提醒 ${host.nick}：${visitor.nick} @ ${post.title}`);
        else if (!result.skipped) console.error(`[notify] 发信失败：${result.reason}`);
      })
      .catch((err) => console.error('[notify] 发信异常', err));
  }
  if (fired.length) store.save();
  return fired;
}

/** 扫一遍所有帖子（由 presence 的定时打点驱动）。 */
function sweep() {
  const posts = store.data().posts;
  const fired = [];
  for (const id of Object.keys(posts)) fired.push(...checkPost(posts[id]));
  return fired;
}

module.exports = { checkPost, sweep, buildEmail, formatDuration, DWELL_THRESHOLD_MS, MIN_MESSAGES };
