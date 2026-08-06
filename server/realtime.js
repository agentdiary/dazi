'use strict';

/**
 * 基于 SSE（Server-Sent Events）的实时推送。
 * 相比 WebSocket：零依赖、走普通 HTTP、经 nginx 反代只需关掉 buffering，
 * 断线由浏览器自动重连，足够支撑看板刷新与帖子内聊天。
 */

const channels = new Map(); // channel -> Set<res>

function subscribe(channel, res) {
  let set = channels.get(channel);
  if (!set) {
    set = new Set();
    channels.set(channel, set);
  }
  set.add(res);
  res.on('close', () => {
    set.delete(res);
    if (set.size === 0) channels.delete(channel);
  });
}

function openStream(req, res, channel) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // 关键：让 nginx 不缓冲 SSE
  });
  res.write(`retry: 3000\n\n`);
  subscribe(channel, res);

  const ping = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch (_) {
      clearInterval(ping);
    }
  }, 25000);
  res.on('close', () => clearInterval(ping));
}

function publish(channel, event, payload) {
  const set = channels.get(channel);
  if (!set || set.size === 0) return;
  const frame = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of set) {
    try {
      res.write(frame);
    } catch (_) {
      set.delete(res);
    }
  }
}

/** 把某个帖子频道里的所有连接踢掉（锁帖后让无权限的人立刻断开）。 */
function closeChannel(channel, event, payload) {
  const set = channels.get(channel);
  if (!set) return;
  publish(channel, event, payload);
  for (const res of set) {
    try {
      res.end();
    } catch (_) {
      /* ignore */
    }
  }
  channels.delete(channel);
}

const boardChannel = () => 'board';
const postChannel = (postId) => `post:${postId}`;

module.exports = { openStream, publish, closeChannel, boardChannel, postChannel };
