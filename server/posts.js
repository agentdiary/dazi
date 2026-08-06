'use strict';

/** 帖子（拉搭子的「卡片」）领域逻辑：状态流转、看板分栏、权限判定。 */

const crypto = require('crypto');
const store = require('./store');
const identity = require('./identity');
const { LIMITS } = require('./config');

/** 看板分类：卡片的一级归属，同时用作筛选。 */
const CATEGORIES = [
  { id: 'ball', label: '球类运动', emoji: '🏀' },
  { id: 'movie', label: '看电影', emoji: '🎬' },
  { id: 'food', label: '搭饭', emoji: '🍜' },
  { id: 'study', label: '自习考研', emoji: '📚' },
  { id: 'game', label: '游戏桌游', emoji: '🎮' },
  { id: 'trip', label: '出行旅游', emoji: '🚄' },
  { id: 'fitness', label: '健身跑步', emoji: '🏃' },
  { id: 'other', label: '其他', emoji: '✨' },
];

/** 看板的四个泳道。locked / done 由发起人控制，open / filling 自动计算。 */
const COLUMNS = [
  { id: 'open', label: '招募中', emoji: '🌱', hint: '刚发起，等人来搭' },
  { id: 'filling', label: '快满了', emoji: '🔥', hint: '名额过半，手慢无' },
  { id: 'locked', label: '已锁定', emoji: '🔒', hint: '发起人已锁帖，仅成员可进' },
  { id: 'done', label: '已完成', emoji: '🎉', hint: '活动已结束/已成行' },
];

/** 发帖时可勾选的备选项目，帖子内可多选，报名的人再从中挑自己想去的。 */
const PRESET_OPTIONS = [
  { label: '篮球', emoji: '🏀' }, { label: '羽毛球', emoji: '🏸' },
  { label: '乒乓球', emoji: '🏓' }, { label: '足球', emoji: '⚽' },
  { label: '网球', emoji: '🎾' }, { label: '看电影', emoji: '🎬' },
  { label: '密室逃脱', emoji: '🔦' }, { label: '剧本杀', emoji: '🕵️' },
  { label: '火锅', emoji: '🍲' }, { label: '烧烤', emoji: '🍢' },
  { label: '奶茶', emoji: '🧋' }, { label: '食堂拼饭', emoji: '🍚' },
  { label: '图书馆自习', emoji: '📚' }, { label: '考研自习', emoji: '✏️' },
  { label: '夜跑', emoji: '🌙' }, { label: '健身房', emoji: '💪' },
  { label: '爬山', emoji: '⛰️' }, { label: '骑行', emoji: '🚴' },
  { label: 'KTV', emoji: '🎤' }, { label: '桌游', emoji: '🎲' },
  { label: '开黑', emoji: '🎮' }, { label: '逛街', emoji: '🛍️' },
  { label: '拍照', emoji: '📷' }, { label: '周边游', emoji: '🚄' },
];

function newId() {
  return crypto.randomBytes(6).toString('hex');
}

function clampText(value, max, fallback = '') {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim().replace(/\s+/g, ' ');
  return trimmed.slice(0, max);
}

function memberCount(post) {
  return Object.keys(post.members).length;
}

/** 帖子当前所在的看板泳道。 */
function columnOf(post) {
  if (post.status === 'done') return 'done';
  if (post.locked) return 'locked';
  const count = memberCount(post);
  if (post.capacity > 0 && count >= Math.ceil(post.capacity * 0.6)) return 'filling';
  return 'open';
}

function isHost(post, uid) {
  return Boolean(uid) && post.hostId === uid;
}

function isMember(post, uid) {
  return Boolean(uid) && Object.prototype.hasOwnProperty.call(post.members, uid);
}

/**
 * 能否进入帖子内部（看详情 + 聊天）。
 * 未锁定 → 所有人可进；锁定后 → 只有发起人和已加入的成员可进。
 */
function canEnter(post, uid) {
  if (!post.locked) return true;
  return isHost(post, uid) || isMember(post, uid);
}

function hashCode(code) {
  return crypto.createHash('sha256').update(String(code).trim().toLowerCase()).digest('hex');
}

function optionTally(post) {
  const tally = {};
  for (const opt of post.options) tally[opt.id] = 0;
  for (const uid of Object.keys(post.members)) {
    const choice = post.members[uid].optionId;
    if (choice && tally[choice] !== undefined) tally[choice] += 1;
  }
  return tally;
}

function serializeMember(post, uid) {
  const user = store.data().users[uid];
  return {
    ...identity.publicUser(user),
    optionId: post.members[uid].optionId,
    joinedAt: post.members[uid].joinedAt,
    isHost: post.hostId === uid,
  };
}

function serializeMessage(msg) {
  const user = msg.uid ? store.data().users[msg.uid] : null;
  return {
    id: msg.id,
    text: msg.text,
    ts: msg.ts,
    kind: msg.kind || 'msg',
    author: msg.kind === 'system' ? null : identity.publicUser(user),
  };
}

/**
 * 看板卡片视图。锁定的帖子对外只暴露标题等元信息，
 * 描述、成员名单、聊天记录一律不下发——「不让别人进来」要在数据层就成立。
 */
function serializeCard(post, viewerUid) {
  const entered = canEnter(post, viewerUid);
  const host = store.data().users[post.hostId];
  return {
    id: post.id,
    title: post.title,
    desc: entered ? post.desc : '',
    category: post.category,
    campus: post.campus,
    place: entered ? post.place : '',
    timeText: post.timeText,
    capacity: post.capacity,
    memberCount: memberCount(post),
    options: post.options,
    tally: entered ? optionTally(post) : null,
    locked: post.locked,
    hasLockCode: Boolean(post.lockCodeHash),
    status: post.status,
    column: columnOf(post),
    host: identity.publicUser(host),
    isHost: isHost(post, viewerUid),
    isMember: isMember(post, viewerUid),
    canEnter: entered,
    myOptionId: post.members[viewerUid] ? post.members[viewerUid].optionId : null,
    messageCount: post.messages.length,
    createdAt: post.createdAt,
    updatedAt: post.updatedAt,
  };
}

/** 帖子详情：卡片 + 成员名单 + 聊天记录（仅在有权进入时）。 */
function serializeDetail(post, viewerUid) {
  const card = serializeCard(post, viewerUid);
  if (!card.canEnter) return { ...card, members: [], messages: [], blocked: true };
  return {
    ...card,
    blocked: false,
    members: Object.keys(post.members)
      .sort((a, b) => post.members[a].joinedAt - post.members[b].joinedAt)
      .map((uid) => serializeMember(post, uid)),
    messages: post.messages.map(serializeMessage),
  };
}

function systemMessage(post, text) {
  const msg = { id: newId(), uid: null, text, ts: Date.now(), kind: 'system' };
  post.messages.push(msg);
  trimMessages(post);
  return msg;
}

function trimMessages(post) {
  if (post.messages.length > LIMITS.messagesPerPost) {
    post.messages.splice(0, post.messages.length - LIMITS.messagesPerPost);
  }
}

module.exports = {
  CATEGORIES,
  COLUMNS,
  PRESET_OPTIONS,
  newId,
  clampText,
  memberCount,
  columnOf,
  isHost,
  isMember,
  canEnter,
  hashCode,
  optionTally,
  serializeCard,
  serializeDetail,
  serializeMember,
  serializeMessage,
  systemMessage,
  trimMessages,
};
