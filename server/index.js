'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { PORT, HOST, PUBLIC_DIR, REQUIRE_LOGIN } = require('./config');
const store = require('./store');
const api = require('./api');
const presence = require('./presence');
const notify = require('./notify');
const mailer = require('./mailer');
const auth = require('./auth');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.join(PUBLIC_DIR, rel);
  // 防目录穿越
  if (!file.startsWith(PUBLIC_DIR + path.sep) && file !== path.join(PUBLIC_DIR, 'index.html')) {
    return api.fail(res, 403, 'forbidden');
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      // 前端是单页应用，未知路径回落到 index.html
      if (!path.extname(rel)) {
        return fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, html) => {
          if (e2) return api.fail(res, 404, 'not found');
          res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' });
          res.end(html);
        });
      }
      return api.fail(res, 404, 'not found');
    }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300',
    });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch (_) {
    return api.fail(res, 400, 'bad request');
  }

  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');

  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
  }

  if (url.pathname.startsWith('/api/')) {
    return Promise.resolve(api.handle(req, res, url)).catch((err) => {
      console.error('[api]', req.method, url.pathname, err);
      if (!res.headersSent) api.fail(res, 400, err.message || '请求处理失败');
    });
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') return api.fail(res, 405, 'method not allowed');
  return serveStatic(req, res, url.pathname);
});

// SSE 连接是长连接，不要被默认超时掐断
server.requestTimeout = 0;
server.headersTimeout = 60_000;
server.keepAliveTimeout = 76_000;

store.load();

// 每 30 秒结算一次各房间的停留时长，顺带检查有没有该给发起人发提醒的
presence.startTicking(() => notify.sweep());

// 管理员账号按环境变量准备好之后再开始接收请求，避免刚启动时后台进不去
auth.bootstrapAdmin()
  .catch((err) => console.error('[dazi] 管理员账号初始化失败', err))
  .then(() => {
    server.listen(PORT, HOST, () => {
      console.log(`[dazi] 校园搭子 running on http://${HOST}:${PORT}`);
      console.log(`[dazi] 发言权限：${REQUIRE_LOGIN ? '需登录后才能发言' : '匿名即可发言（免注册）'}`);
      console.log(`[dazi] 邮件提醒：${mailer.enabled() ? `已启用（${process.env.DAZI_SMTP_HOST}）` : '未配置 SMTP，仅站内提醒'}`);
    });
  });

function shutdown(signal) {
  console.log(`[dazi] ${signal} received, saving data...`);
  store.saveSync();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
