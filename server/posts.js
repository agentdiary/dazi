'use strict';

/** 帖子（拉搭子的「卡片」）领域逻辑：状态流转、看板分栏、权限判定。 */

const crypto = require('crypto');
const store = require('./store');
const identity = require('./identity');
const presence = require('./presence');
const { LIMITS } = require('./config');

/** 看板分类：卡片的一级归属，同时用作筛选。 */
const CATEGORIES = [
  { id: 'ball', label: '球类运动', emoji: '🏀', labelEn: 'Sports' },
  { id: 'movie', label: '看电影', emoji: '🎬', labelEn: 'Movies' },
  { id: 'food', label: '搭饭', emoji: '🍜', labelEn: 'Food' },
  { id: 'study', label: '自习考研', emoji: '📚', labelEn: 'Study' },
  { id: 'game', label: '游戏桌游', emoji: '🎮', labelEn: 'Games' },
  { id: 'trip', label: '出行旅游', emoji: '🚄', labelEn: 'Travel' },
  { id: 'fitness', label: '健身跑步', emoji: '🏃', labelEn: 'Fitness' },
  { id: 'other', label: '其他', emoji: '✨', labelEn: 'Other' },
];

/**
 * 招募状态。locked / done 由发起人控制，open / filling 按人数自动计算。
 * 它是卡片上的徽标 + 筛选项，不再是版面结构——帖子多少不该由状态决定占多大地方。
 */
const STATES = [
  { id: 'open', label: '招募中', emoji: '🌱', hint: '还有空位，随时可以进', labelEn: 'Recruiting', hintEn: 'Spots still open, jump in anytime' },
  { id: 'filling', label: '快满了', emoji: '🔥', hint: '名额过六成，手慢无', labelEn: 'Filling up', hintEn: 'Over 60% full, act fast' },
  { id: 'locked', label: '已锁定', emoji: '🔒', hint: '发起人已锁帖，仅成员可进', labelEn: 'Locked', hintEn: 'Organiser locked it; members only' },
  { id: 'done', label: '已完成', emoji: '🎉', hint: '活动已结束/已成行', labelEn: 'Finished', hintEn: 'The meetup has happened or ended' },
];

/** 排序方式。默认按最近活跃，让还在聊的局浮上来。 */
const SORTS = [
  { id: 'active', label: '最近活跃', emoji: '⚡', labelEn: 'Recently active' },
  { id: 'new', label: '最新发布', emoji: '🆕', labelEn: 'Newest' },
  { id: 'seats', label: '空位最多', emoji: '🪑', labelEn: 'Most spots left' },
  { id: 'people', label: '人气最高', emoji: '👥', labelEn: 'Most popular' },
  { id: 'state', label: '按招募状态', emoji: '🚦', labelEn: 'By status' },
];

/** 发帖时可勾选的备选项目，帖子内可多选，报名的人再从中挑自己想去的。 */
const PRESET_OPTIONS = [
  { label: '篮球', labelEn: 'Basketball', emoji: '🏀' }, { label: '羽毛球', labelEn: 'Badminton', emoji: '🏸' },
  { label: '乒乓球', labelEn: 'Table tennis', emoji: '🏓' }, { label: '足球', labelEn: 'Football', emoji: '⚽' },
  { label: '网球', labelEn: 'Tennis', emoji: '🎾' }, { label: '看电影', labelEn: 'Movie', emoji: '🎬' },
  { label: '密室逃脱', labelEn: 'Escape room', emoji: '🔦' }, { label: '剧本杀', labelEn: 'Murder mystery', emoji: '🕵️' },
  { label: '火锅', labelEn: 'Hot pot', emoji: '🍲' }, { label: '烧烤', labelEn: 'BBQ', emoji: '🍢' },
  { label: '奶茶', labelEn: 'Bubble tea', emoji: '🧋' }, { label: '食堂拼饭', labelEn: 'Dining hall', emoji: '🍚' },
  { label: '图书馆自习', labelEn: 'Library study', emoji: '📚' }, { label: '考研自习', labelEn: 'Exam prep', emoji: '✏️' },
  { label: '夜跑', labelEn: 'Night run', emoji: '🌙' }, { label: '健身房', labelEn: 'Gym', emoji: '💪' },
  { label: '爬山', labelEn: 'Hiking', emoji: '⛰️' }, { label: '骑行', labelEn: 'Cycling', emoji: '🚴' },
  { label: 'KTV', labelEn: 'Karaoke', emoji: '🎤' }, { label: '桌游', labelEn: 'Board games', emoji: '🎲' },
  { label: '开黑', labelEn: 'Gaming', emoji: '🎮' }, { label: '逛街', labelEn: 'Shopping', emoji: '🛍️' },
  { label: '拍照', labelEn: 'Photo walk', emoji: '📷' }, { label: '周边游', labelEn: 'Day trip', emoji: '🚄' },
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

/** 帖子当前的招募状态。 */
function stateOf(post) {
  if (post.status === 'done') return 'done';
  if (post.locked) return 'locked';
  const count = memberCount(post);
  if (post.capacity > 0 && count >= Math.ceil(post.capacity * 0.6)) return 'filling';
  return 'open';
}

const STATE_ORDER = { open: 0, filling: 1, locked: 2, done: 3 };

/** 排序比较器。空位/人气这类相同时，一律回落到最近活跃，保证顺序稳定。 */
function comparator(sort) {
  const byActive = (a, b) => b.updatedAt - a.updatedAt;
  switch (sort) {
    case 'new':
      return (a, b) => b.createdAt - a.createdAt || byActive(a, b);
    case 'seats':
      return (a, b) => (b.capacity - b.memberCount) - (a.capacity - a.memberCount) || byActive(a, b);
    case 'people':
      return (a, b) => b.memberCount - a.memberCount || byActive(a, b);
    case 'state':
      return (a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || byActive(a, b);
    case 'active':
    default:
      return byActive;
  }
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

/**
 * 帖子里存的选项只留了中文 label（发帖那一刻用户选的），
 * 序列化时按预设表补回英文名，这样英文界面下也能正确显示；
 * 用户自定义的项目没有对应翻译，原样返回即可。
 */
function serializeOptions(post) {
  return post.options.map((opt) => {
    if (opt.labelEn) return opt;
    const preset = PRESET_OPTIONS.find((p) => p.label === opt.label);
    return preset ? { ...opt, labelEn: preset.labelEn } : opt;
  });
}

function serializeMember(post, uid) {
  const user = store.data().users[uid];
  return {
    ...identity.publicUser(user),
    optionId: post.members[uid].optionId,
    joinedAt: post.members[uid].joinedAt,
    isHost: post.hostId === uid,
    online: presence.isOnline(uid),
    inRoom: presence.whoIsInRoom(post.id).includes(uid),
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
  const inRoom = presence.whoIsInRoom(post.id);
  const onlineMembers = Object.keys(post.members).filter((uid) => presence.isOnline(uid));
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
    onlineCount: onlineMembers.length,
    inRoomCount: entered ? inRoom.length : 0,
    hostOnline: presence.isOnline(post.hostId),
    options: serializeOptions(post),
    tally: entered ? optionTally(post) : null,
    locked: post.locked,
    hasLockCode: Boolean(post.lockCodeHash),
    status: post.status,
    state: stateOf(post),
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
  STATES,
  SORTS,
  PRESET_OPTIONS,
  newId,
  clampText,
  memberCount,
  serializeOptions,
  stateOf,
  comparator,
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
