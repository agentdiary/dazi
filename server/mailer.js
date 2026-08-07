'use strict';

/**
 * 极简 SMTP 客户端。
 *
 * 为什么自己写：整个项目坚持零 npm 依赖，部署时不用 npm install。
 * 发信这点需求（一封纯文本、一个收件人）用 node:tls 手写百来行就够了，
 * 不值得为它引入 nodemailer 及其依赖树。
 *
 * 支持两种常见姿势：
 *   - 隐式 TLS（465）：QQ 邮箱、163 邮箱的推荐端口
 *   - STARTTLS（587/25）：Gmail、企业邮箱、自建 postfix
 *
 * 没配 SMTP 环境变量时，send() 直接返回 { skipped: true }，
 * 站内提醒照常工作，不会因为没配邮箱就报错。
 */

const net = require('net');
const tls = require('tls');

const CONFIG = {
  host: process.env.DAZI_SMTP_HOST || '',
  port: Number(process.env.DAZI_SMTP_PORT || 465),
  user: process.env.DAZI_SMTP_USER || '',
  pass: process.env.DAZI_SMTP_PASS || '',
  from: process.env.DAZI_SMTP_FROM || process.env.DAZI_SMTP_USER || '',
  fromName: process.env.DAZI_SMTP_FROM_NAME || '校园搭子',
  // 465 默认隐式 TLS，其它端口默认 STARTTLS
  secure: process.env.DAZI_SMTP_SECURE
    ? process.env.DAZI_SMTP_SECURE !== '0'
    : Number(process.env.DAZI_SMTP_PORT || 465) === 465,
  // 只有本机 postfix 或测试环境才该打开：允许在服务器不支持 STARTTLS 时明文发信
  allowPlaintext: process.env.DAZI_SMTP_ALLOW_PLAINTEXT === '1',
};

const enabled = () => Boolean(CONFIG.host && CONFIG.user && CONFIG.pass);

function isValidAddress(address) {
  return typeof address === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address.trim());
}

/** RFC 2047：非 ASCII 的主题/显示名要编码，否则客户端会显示成乱码。 */
function encodeHeader(text) {
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7F]*$/.test(text)) return text;
  return `=?UTF-8?B?${Buffer.from(text, 'utf8').toString('base64')}?=`;
}

function wrap(base64) {
  return (base64.match(/.{1,76}/g) || []).join('\r\n');
}

/** 一问一答的 SMTP 会话封装：写一行、等一个期望的状态码。 */
function createSession(socket, timeoutMs) {
  let buffer = '';
  let waiter = null;

  socket.setEncoding('utf8');
  socket.on('data', (chunk) => {
    buffer += chunk;
    if (!waiter) return;
    // 多行响应以 "250 xxx"（第四个字符是空格）收尾
    const lines = buffer.split('\r\n').filter(Boolean);
    const last = lines[lines.length - 1];
    if (!last || last[3] === '-') return;
    const done = waiter;
    waiter = null;
    const payload = buffer;
    buffer = '';
    done.resolve({ code: Number(last.slice(0, 3)), text: payload });
  });

  function expect(codes) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiter = null;
        reject(new Error('SMTP 响应超时'));
      }, timeoutMs);
      waiter = {
        resolve: (res) => {
          clearTimeout(timer);
          if (codes.includes(res.code)) return resolve(res);
          reject(new Error(`SMTP 期望 ${codes.join('/')}，实际 ${res.code}: ${res.text.trim()}`));
        },
      };
    });
  }

  function send(line) {
    socket.write(`${line}\r\n`);
  }

  return { expect, send };
}

/**
 * 发一封纯文本邮件。
 * @returns {Promise<{sent:boolean, skipped?:boolean, reason?:string}>}
 */
async function send({ to, subject, text }) {
  if (!enabled()) return { sent: false, skipped: true, reason: '未配置 SMTP' };
  if (!isValidAddress(to)) return { sent: false, skipped: true, reason: '收件地址不合法' };

  const timeoutMs = Number(process.env.DAZI_SMTP_TIMEOUT || 15000);
  const from = CONFIG.from || CONFIG.user;

  let socket = CONFIG.secure
    ? tls.connect({ host: CONFIG.host, port: CONFIG.port, servername: CONFIG.host })
    : net.connect({ host: CONFIG.host, port: CONFIG.port });

  const cleanup = () => { try { socket.destroy(); } catch (_) { /* ignore */ } };

  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('连接 SMTP 服务器超时')), timeoutMs);
      socket.once(CONFIG.secure ? 'secureConnect' : 'connect', () => { clearTimeout(timer); resolve(); });
      socket.once('error', (err) => { clearTimeout(timer); reject(err); });
    });

    let session = createSession(socket, timeoutMs);
    await session.expect([220]);

    session.send('EHLO dazi');
    const greeting = await session.expect([250]);

    if (!CONFIG.secure && !/STARTTLS/i.test(greeting.text) && CONFIG.allowPlaintext) {
      // 仅用于本机 postfix / 测试：明确开启才允许不加密发信
      console.warn('[mailer] 以明文方式发信（DAZI_SMTP_ALLOW_PLAINTEXT=1）');
    } else if (!CONFIG.secure) {
      if (!/STARTTLS/i.test(greeting.text)) throw new Error('服务器不支持 STARTTLS，请改用 465 端口');
      session.send('STARTTLS');
      await session.expect([220]);
      socket = tls.connect({ socket, servername: CONFIG.host });
      await new Promise((resolve, reject) => {
        socket.once('secureConnect', resolve);
        socket.once('error', reject);
      });
      session = createSession(socket, timeoutMs);
      session.send('EHLO dazi');
      await session.expect([250]);
    }

    session.send('AUTH LOGIN');
    await session.expect([334]);
    session.send(Buffer.from(CONFIG.user, 'utf8').toString('base64'));
    await session.expect([334]);
    session.send(Buffer.from(CONFIG.pass, 'utf8').toString('base64'));
    await session.expect([235]);

    session.send(`MAIL FROM:<${from}>`);
    await session.expect([250]);
    session.send(`RCPT TO:<${to.trim()}>`);
    await session.expect([250, 251]);
    session.send('DATA');
    await session.expect([354]);

    const headers = [
      `From: ${encodeHeader(CONFIG.fromName)} <${from}>`,
      `To: <${to.trim()}>`,
      `Subject: ${encodeHeader(subject)}`,
      `Date: ${new Date().toUTCString()}`,
      `Message-ID: <${Date.now()}.${Math.random().toString(36).slice(2)}@dazi>`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
    ].join('\r\n');

    // 正文走 base64，天然避开「行首单独一个点」会提前结束 DATA 的坑
    socket.write(`${headers}\r\n\r\n${wrap(Buffer.from(text, 'utf8').toString('base64'))}\r\n.\r\n`);
    await session.expect([250]);

    session.send('QUIT');
    cleanup();
    return { sent: true };
  } catch (err) {
    cleanup();
    return { sent: false, reason: err.message };
  }
}

module.exports = { send, enabled, isValidAddress, CONFIG };
