'use strict';

const path = require('path');

const DATA_DIR = process.env.DAZI_DATA_DIR
  ? path.resolve(process.env.DAZI_DATA_DIR)
  : path.join(__dirname, '..', 'data');

module.exports = {
  PORT: Number(process.env.DAZI_PORT || 8080),
  HOST: process.env.DAZI_HOST || '127.0.0.1',
  DATA_DIR,
  DB_FILE: path.join(DATA_DIR, 'dazi.json'),
  SECRET_FILE: path.join(DATA_DIR, 'secret.key'),
  PUBLIC_DIR: path.join(__dirname, '..', 'public'),

  // 身份 cookie 有效期：一年。免注册，但身份长期保持统一。
  COOKIE_NAME: 'dazi_id',
  COOKIE_MAX_AGE: 365 * 24 * 3600,

  LIMITS: {
    nick: 16,
    title: 40,
    desc: 300,
    place: 40,
    timeText: 40,
    message: 500,
    optionLabel: 12,
    optionsPerPost: 8,
    capacity: 50,
    messagesPerPost: 500,
    postsPerUserPerHour: 10,
    messagesPerMinute: 20,
  },
};
