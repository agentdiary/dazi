'use strict';

/**
 * 服务端文案的中英对照。
 *
 * 设计取巧但有意为之：**用中文原文当 key**。这样 40 多处 fail(res, 400, '……')
 * 一个都不用改，只在 fail() 这个唯一出口做一次翻译。新增错误信息时忘了加翻译，
 * 也只是回落到中文，不会变成 undefined 或报错。
 *
 * 语言取自请求头 X-Dazi-Lang，其次 Accept-Language，默认中文。
 */

const EN = {
  /* 通用 */
  '接口不存在': 'Endpoint not found',
  '不支持的操作': 'Unsupported action',
  '请求体过大': 'Request body too large',
  '请求体不是合法 JSON': 'Request body is not valid JSON',
  '请求处理失败': 'Request failed',

  /* 身份 */
  '昵称不能为空': 'Nickname cannot be empty',
  '这个昵称已经被别的同学用了，换一个吧': 'That nickname is taken, please pick another',
  '邮箱格式不太对': "That email address doesn't look right",
  '身份口令无效，请检查后重试': 'Invalid identity code, please check and try again',

  /* 账号 */
  '这个身份已经注册过账号了': 'This identity already has an account',
  '这个用户名已经被占用了': 'That username is already taken',
  '用户名需要 3-20 位，可用中英文、数字、下划线和连字符':
    'Username must be 3-20 characters: letters, digits, underscore or hyphen',
  '用户名或密码不对': 'Wrong username or password',
  '这个账号已被管理员封禁': 'This account has been banned by an administrator',
  '当前身份还没有注册账号': 'This identity has no account yet',
  '原密码不对': 'Current password is incorrect',
  '密码太长了': 'Password is too long',
  '尝试太频繁了，过会儿再试': 'Too many attempts, please try again later',
  '登录尝试过多，请十分钟后再试': 'Too many login attempts, please try again in 10 minutes',
  '本站已开启「登录后才能发言」，请先注册或登录':
    'This site requires an account to post. Please register or log in first',
  '你的账号已被管理员封禁，无法发帖或发言':
    'Your account has been banned by an administrator; you cannot post or chat',

  /* 管理员 */
  '需要管理员权限': 'Administrator access required',
  '找不到这个用户': 'User not found',
  '不能对自己执行这个操作': "You can't do that to yourself",
  '至少要保留一个管理员': 'At least one administrator must remain',
  '消息不存在': 'Message not found',

  /* 帖子 */
  '帖子不存在': 'Post not found',
  '这个帖子不存在或已被删除': 'This post does not exist or has been deleted',
  '给你的搭子局起个标题吧': 'Give your meetup a title',
  '至少选一个想一起做的项目': 'Pick at least one activity',
  '发帖太频繁啦，休息一下再来': 'You are posting too often, take a short break',
  '只有发起人可以修改这个帖子': 'Only the organiser can edit this post',
  '只有发起人可以删除这个帖子': 'Only the organiser can delete this post',
  '只有发起人可以移出成员': 'Only the organiser can remove members',
  '找不到这个成员': 'Member not found',
  '人数已满，来晚一步': 'This meetup is full',
  '这个局已经结束啦': 'This meetup has already finished',
  '这个局已经结束了': 'This meetup has already finished',
  '你还没有加入这个局': 'You have not joined this meetup',
  '发起人不能退出，可以直接删除或标记完成':
    'The organiser cannot leave; delete the post or mark it finished instead',
  '先加入这个局才能选项目': 'Join the meetup before choosing an activity',
  '没有这个选项': 'No such option',

  /* 锁帖 */
  '帖子已被锁定，你现在进不去': 'This post is locked; you cannot enter',
  '帖子已被锁定，进不去哦': 'This post is locked',
  '该帖子已被发起人锁定': 'This post has been locked by its organiser',

  /* 聊天 */
  '说点什么吧': 'Say something first',
  '说得太快啦，缓一缓': 'You are sending messages too fast, slow down a little',
};

/** 从请求里判断语言。前端会显式带 X-Dazi-Lang，其余情况看浏览器偏好。 */
function langOf(req) {
  const explicit = req.headers['x-dazi-lang'];
  if (explicit) return String(explicit).toLowerCase().startsWith('en') ? 'en' : 'zh';
  const accept = req.headers['accept-language'] || '';
  // 只有在英文明显排在中文前面时才用英文，避免误判
  const zhIndex = accept.toLowerCase().indexOf('zh');
  const enIndex = accept.toLowerCase().indexOf('en');
  if (enIndex >= 0 && (zhIndex < 0 || enIndex < zhIndex)) return 'en';
  return 'zh';
}

/** 翻译一条文案；没有对应翻译时原样返回，绝不返回 undefined。 */
function t(text, lang) {
  if (lang !== 'en') return text;
  return EN[text] || text;
}

module.exports = { t, langOf, EN };
