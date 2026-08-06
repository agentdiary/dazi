# 校园搭子 · dazi

> 一张看板，找到一起干的人。

看板（Kanban）风格的校园「搭子」社交网站：把每一个「求搭子」的局做成一张卡片，
在四条泳道之间流动；卡片里可以放**多个备选项目**（篮球 / 羽毛球 / 看电影 / 火锅 / 自习…），
报名的人各自投自己想去的那个；每张卡片内部自带**聊天室**；发起人可以随时**把帖子锁住，不让别人进来**。

**免注册、免密码**——打开就能发言，但身份由服务器签发并全站保持统一。

---

## 功能

### 看板

四条泳道，卡片自动流动，发起人可以直接拖动自己的卡片改状态：

| 泳道 | 含义 | 谁能移动 |
| --- | --- | --- |
| 🌱 招募中 | 刚发起，等人来搭 | 自动 / 发起人拖回 |
| 🔥 快满了 | 名额过 60%，手慢无 | 自动计算，不能手动拖入 |
| 🔒 已锁定 | 发起人锁了帖，只有成员能进 | 发起人 |
| 🎉 已完成 | 活动已成行 / 已结束 | 发起人 |

顶部还有分类筛选（球类、看电影、搭饭、自习考研、游戏桌游、出行、健身、其他）、
关键词搜索、「只看我的」。

### 一个帖子里放多个选项

发帖时从 24 个预设项目里勾选，也可以自定义，最多 8 个。
报名的人从中选一个自己想参加的，卡片上实时显示票数（`🏀 篮球 ×3`），
发起人一眼看出大家到底想干嘛。加入之后随时可以改投。

### 帖子内部的沟通平台

每个帖子自带聊天室：成员发言、加入 / 退出 / 锁帖都会留下系统消息。
实时推送走 SSE（Server-Sent Events），断线浏览器自动重连——不需要 WebSocket 依赖。

### 锁帖：不让别人进来

发起人点「🔒 锁住帖子」（或把卡片拖进「已锁定」泳道）后：

- 没加入的人**打不开**帖子详情，看不到说明、地点、成员名单和任何一条聊天记录——
  这些字段在**服务端**就不下发，不是前端藏起来；
- 不能加入、不能发言；
- 已经加入的成员照常聊天；
- 锁帖时可以选择设一个**暗号**，知道暗号的人仍然能进来（不设则彻底关门）；
- 随时可以解锁。

### 免注册，但身份统一

| 做法 | 效果 |
| --- | --- |
| 首次访问服务端签发 uid，写进 **HMAC 签名的 httpOnly Cookie** | 不用注册就能发言；Cookie 被篡改会验签失败，无法冒充别人 |
| 昵称**全站唯一**，且展示时永远带 `#短号` | 同一个人在看板、成员列表、聊天里都是同一个可辨识身份 |
| 每个身份配一串**身份口令** | 换设备 / 清了缓存，粘贴口令就还是同一个你（口令只存哈希） |
| 改昵称、换头像后全站历史署名一起更新 | 身份不会分裂成好几个 |

---

## 技术选型

**零 npm 依赖**，只用 Node.js 内置模块。没有构建步骤，前端是原生 JS。
这样部署时不用装编译工具链、不会因为原生模块编译失败而挂掉，`git pull` 之后重启即可。

```
server/
  index.js      HTTP 服务 + 静态文件 + 优雅退出
  api.js        REST 路由、限流、权限校验
  posts.js      帖子领域逻辑：泳道计算、锁帖判定、序列化（锁帖时在此裁掉敏感字段）
  identity.js   免注册身份：HMAC Cookie、昵称唯一、身份口令
  realtime.js   SSE 推送（看板频道 + 每个帖子一个频道）
  store.js      JSON 持久化，防抖 + 原子写
public/         看板前端（原生 JS / CSS，无框架）
test/smoke.js   45 项端到端冒烟测试
deploy/         一键部署脚本
```

数据全部落在一个 `dazi.json` 里，备份就是复制一个文件。

---

## 本地运行

```bash
git clone https://github.com/agentdiary/dazi.git
cd dazi
npm start          # 默认 http://127.0.0.1:8080
npm run smoke      # 跑一遍端到端测试（45 项）
```

需要 Node.js ≥ 18，不需要 `npm install`。

---

## 部署到服务器

在服务器上执行：

```bash
git clone https://github.com/agentdiary/dazi.git
cd dazi
sudo bash deploy/install.sh
```

脚本会自动完成：准备 Node 运行时 → 安装到 `/opt/dazi`、数据放 `/var/lib/dazi` →
注册 `dazi.service`（systemd，开机自启、崩溃自动重启）→
挑一个没被占用的本地端口 → 新增一个 nginx 站点（**不会动服务器上已有的站点**）→
用 certbot 申请 HTTPS 证书。

### 它不会碰服务器上已有的东西

这台机器上通常还跑着别的项目，所以脚本刻意做了隔离：

- **不动系统 node**：系统里的 node ≥ 18 就直接复用；低于 18 或者没装，
  就把官方绿色版解压到 `/opt/dazi-runtime` 私有使用，systemd 里写死这个绝对路径，
  既不改 PATH 也不覆盖 `/usr/bin/node`，别的项目的 node 版本保持原样；
- **不动已有 nginx 站点**：只新增 `/etc/nginx/sites-available/dazi` 一个 server 块；
- **不占已用端口**：自动挑空闲端口，重复部署时沿用上次的端口；
- **只写自己的数据目录**：systemd 里 `ProtectSystem=strict` + `ReadWritePaths=/var/lib/dazi`。

### 免费域名

默认用 **sslip.io**：形如 `dazi.<你的IP>.sslip.io` 的域名会自动解析到对应 IP，
不用注册、不用配 DNS、永久免费。本项目部署后的地址就是：

```
https://dazi.43.130.127.226.sslip.io
```

同类免费方案还有 `nip.io`（用法一样）、`eu.org`（免费二级域名，需人工审核）、
FreeDNS 的免费子域。想换成自己的域名：

```bash
sudo DAZI_DOMAIN=dazi.example.com bash deploy/install.sh
```

### 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `DAZI_DOMAIN` | `dazi.<IP>.sslip.io` | 站点域名 |
| `DAZI_PORT` | 自动挑空闲端口 | 应用监听的本地端口 |
| `DAZI_DATA_DIR` | `/var/lib/dazi` | 数据目录 |
| `DAZI_SECRET` | 首次启动随机生成并存盘 | 身份 Cookie 的签名密钥 |
| `DAZI_SKIP_TLS` | `0` | 设为 `1` 跳过证书申请 |
| `DAZI_EMAIL` | `admin@<域名>` | Let's Encrypt 通知邮箱 |

### 自动部署（GitHub Actions）

`.github/workflows/deploy.yml` 会在推送到 `main` 时先跑测试再 SSH 部署。
需要在仓库 Settings → Secrets 里配置 `DEPLOY_HOST` / `DEPLOY_USER` / `DEPLOY_KEY`，
也可以在 Actions 页手动触发（workflow_dispatch）。

### 运维

```bash
systemctl status dazi          # 状态
journalctl -u dazi -f          # 实时日志
systemctl restart dazi         # 重启
cp /var/lib/dazi/dazi.json ~/  # 备份全部数据
```

---

## API

所有接口都基于 Cookie 里的身份，无需任何 token。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/meta` | 分类、泳道、预设项目、各项长度限制 |
| GET | `/api/me` | 取当前身份（没有则当场签发） |
| PATCH | `/api/me` | 改昵称 / 头像 / 底色（昵称唯一） |
| POST | `/api/me/recovery` | 重新生成身份口令 |
| POST | `/api/session/restore` | 用身份口令在新设备上找回身份 |
| GET | `/api/posts` | 看板卡片，支持 `category` / `q` / `mine` |
| POST | `/api/posts` | 发帖 |
| GET | `/api/posts/:id` | 详情（锁帖时对外人只返回壳） |
| PATCH | `/api/posts/:id` | 发起人改信息 / 锁帖 / 标记完成 |
| DELETE | `/api/posts/:id` | 发起人删帖 |
| POST | `/api/posts/:id/join` | 加入（可带 `code` 走暗号） |
| POST | `/api/posts/:id/leave` | 退出 |
| POST | `/api/posts/:id/vote` | 改投别的项目 |
| POST | `/api/posts/:id/messages` | 在帖子里发言 |
| POST | `/api/posts/:id/kick` | 发起人移出成员 |
| GET | `/api/stream` | 看板实时流（SSE） |
| GET | `/api/posts/:id/stream` | 帖子实时流（SSE，锁帖后外人 403） |
| GET | `/healthz` | 健康检查 |

---

## 安全边界

- 身份 Cookie 用 HMAC-SHA256 签名，`httpOnly` + `SameSite=Lax`，HTTPS 下自动加 `Secure`；
- 锁帖的内容在**序列化阶段**就被裁掉，接口层面拿不到，不依赖前端隐藏；
- 所有写操作校验发起人 / 成员身份；
- 发帖 10 条/小时、发言 20 条/分钟的限流；
- 前端一律用 `textContent` 渲染用户输入，不拼 HTML；
- 静态文件服务做了目录穿越防护；
- systemd 以专用账号运行，`ProtectSystem=strict`，只有数据目录可写。

## License

MIT
