# 校园搭子 · dazi

> 一张卡片，找到一起干的人。中英双语。

校园「搭子」社交网站：把每一个「求搭子」的局做成一张卡片铺在首页，
分类栏可以左右滑动、右端可按状态/人数/时间筛选排序；卡片里能放**多个备选项目**
（篮球 / 羽毛球 / 看电影 / 火锅 / 自习…），报名的人各自投自己想去的那个；
每张卡片内部自带**聊天室**并显示谁在线；发起人可以随时**把帖子锁住，不让别人进来**。

**默认免注册、免密码**——打开就能发言，身份由服务器签发并全站保持统一；
需要时再注册账号（绑定到同一个身份），也可以一键切成**强制登录**。带完整的**管理后台**。

---

## 功能

### 以帖子为主的首页

主体是自适应平铺的帖子卡片，帖子多少都能把版面填满。
分类栏（全部 / 球类运动 / 看电影 / 搭饭 / 自习考研 / 游戏桌游 / 出行 / 健身 / 其他）
可以左右滑动，右端是筛选按钮：

- **排序**：最近活跃（默认）/ 最新发布 / 空位最多 / 人气最高 / 按招募状态
- **招募状态筛选**：全部 / 招募中 / 快满了 / 已锁定 / 已完成，每项带数量

按钮上会直接显示当前生效的条件（如「招募中 · 空位最多」），不用展开就知道自己筛了什么。

招募状态是卡片上的**徽标**，不是版面分栏：

| 状态 | 含义 | 谁能改 |
| --- | --- | --- |
| 🌱 招募中 | 还有空位 | 自动 |
| 🔥 快满了 | 名额过 60% | 自动计算 |
| 🔒 已锁定 | 发起人锁了帖，只有成员能进 | 发起人 |
| 🎉 已完成 | 活动已成行 / 已结束 | 发起人 |

> 早期版本是四列看板。但「招募中」往往堆成山而「已完成」空着，
> 版面被状态分布绑架，所以改成了现在这样：状态降级为徽标 + 筛选项。

### 在线状态

谁在线一眼可见，判定直接复用 SSE 长连接（连接开着就是在线，断开留 45 秒宽限，
避免刷新页面时闪成离线）：

- 卡片上：发起人头像的小绿点 + 「N 在线」
- 帖子里：每个成员的在线状态，正在房间里的人另有「在房间里」标记
- 页脚：全站当前在线人数

### 有人认真看了你的帖子 → 邮件提醒

有人在你的帖子里**累计停留满 30 分钟**、**并且发过至少 1 条消息**时，
给发起人发一封提醒邮件。三个条件缺一不可（发起人自己不算），
每人每帖只提醒一次。邮件里带访客昵称、停留时长、发言条数和可直接点开的帖子链接。

停留时长用「打点累加」统计：每 30 秒把还开着的连接累加一段，断开时补上最后一段。
所以挂着页面不动会算，反复刷新也不会重复计。

发起人要收提醒，得自己在「我的身份」里填一个邮箱——免注册不等于站点能拿到你的联系方式。
邮箱只存在服务端、只用于发提醒，任何接口都不会把它返回给别人，也可以随时关掉开关。
站点没配 SMTP 时功能自动降级：站内照常记录，只是不发信。

### 一个帖子里放多个选项

发帖时从 24 个预设项目里勾选，也可以自定义，最多 8 个。
报名的人从中选一个自己想参加的，卡片上实时显示票数（`🏀 篮球 ×3`），
发起人一眼看出大家到底想干嘛。加入之后随时可以改投。

### 帖子内部的沟通平台

每个帖子自带聊天室：成员发言、加入 / 退出 / 锁帖都会留下系统消息。
实时推送走 SSE（Server-Sent Events），断线浏览器自动重连——不需要 WebSocket 依赖。

### 锁帖：不让别人进来

发起人点「🔒 锁住帖子」后：

- 没加入的人**打不开**帖子详情，看不到说明、地点、成员名单和任何一条聊天记录——
  这些字段在**服务端**就不下发，不是前端藏起来；
- 不能加入、不能发言；
- 已经加入的成员照常聊天；
- 锁帖时可以选择设一个**暗号**，知道暗号的人仍然能进来（不设则彻底关门）；
- 随时可以解锁。

### 账号：注册是可选的，也可以强制

注册**不是新建一个人**，而是给当前这个匿名身份绑定用户名和密码——
注册前发的帖子、说过的话、攒下的 `#短号` 全都继承过来，不会分裂成两个身份。

| 模式 | 怎么开 | 效果 |
| --- | --- | --- |
| 免注册（默认） | 什么都不用配 | 打开就能发言；注册只是多一种换设备找回身份的方式 |
| 强制登录 | `DAZI_REQUIRE_LOGIN=1` | 浏览照常开放，但发帖 / 加入 / 发言都必须先注册登录 |

密码用 scrypt 加盐哈希，比对走 `timingSafeEqual`；登录失败时不区分
「用户名不存在」和「密码错误」，且用户名不存在时同样跑一次哈希，
避免用响应快慢反推账号是否存在。登录接口按用户名限流 10 次 / 10 分钟。

### 管理员

用环境变量引导第一个管理员，启动时自动创建（账号已存在则提升为管理员并重设密码，
这也是忘记密码时的找回手段）：

```bash
sudo DAZI_ADMIN_USER=admin DAZI_ADMIN_PASS=一个够长的密码 bash deploy/install.sh
```

登录后顶栏出现「🛡️ 管理后台」：

- **概览**：用户数、已注册数、在线数、帖子数、锁定数、消息数、封禁数
- **用户**：搜索、封禁 / 解封、设为管理员 / 取消管理员
- **帖子**：查看、锁定 / 解锁、删除；也能删掉单条违规消息

被封禁的人仍可浏览，但发帖、加入、发言一律拒绝，并且无法登录。
两条防呆：不能封禁自己，也不能把最后一个管理员降权（否则后台就再也进不去了）。

### 中英双语

右上角一个按钮切换中 / 英，选择记在本地，刷新后保持；没选过则跟随浏览器语言。
切换覆盖的不只是界面文字：

- 分类、招募状态、排序方式、预设活动都由服务端同时下发中英两份标签；
- **服务端的错误提示也跟着切**——前端请求带上 `X-Dazi-Lang`，
  服务端在 `fail()` 这个唯一出口做一次翻译；
- 英文浏览器首次访问，自动生成的昵称也是英文的（`Sleepy Tabby` 而不是「爱睡觉的橘猫」）；
- 帖子里存的是发帖时选的中文项目名，序列化时按预设表补回英文名，老帖子一并生效；
  用户自定义的活动名不做机器翻译，原样显示。

翻译表用**中文原文当 key**（`server/i18n.js` 和 `public/i18n.js`）：
新增文案时忘了加翻译，只会回落成中文，不会变成空白或 `undefined`。

### 免注册，但身份统一

| 做法 | 效果 |
| --- | --- |
| 首次访问服务端签发 uid，写进 **HMAC 签名的 httpOnly Cookie** | 不用注册就能发言；Cookie 被篡改会验签失败，无法冒充别人 |
| 昵称**全站唯一**，且展示时永远带 `#短号` | 同一个人在首页、成员列表、聊天里都是同一个可辨识身份 |
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
  posts.js      帖子领域逻辑：状态计算、排序、锁帖判定、序列化（锁帖时在此裁掉敏感字段）
  identity.js   免注册身份：HMAC Cookie、昵称唯一、身份口令（中英两套昵称）
  i18n.js       服务端文案中英对照，在 fail() 出口统一翻译
  auth.js       账号体系：scrypt 密码、注册绑定、登录、管理员与封禁
  realtime.js   SSE 推送（首页频道 + 每个帖子一个频道）
  presence.js   在线判定 + 帖子内停留时长打点累加
  notify.js     「停留够久且发过言」的提醒规则与邮件内容
  mailer.js     手写的极简 SMTP 客户端（隐式 TLS / STARTTLS）
  store.js      JSON 持久化，防抖 + 原子写
public/         前端（原生 JS / CSS，无框架），i18n.js 是界面翻译表
test/smoke.js   126 项端到端冒烟测试（含真实 SMTP 链路、强制登录模式、双语）
deploy/         一键部署脚本
```

数据全部落在一个 `dazi.json` 里，备份就是复制一个文件。

---

## 本地运行

```bash
git clone https://github.com/agentdiary/dazi.git
cd dazi
npm start          # 默认 http://127.0.0.1:8080
npm run smoke      # 跑一遍端到端测试（126 项）
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

### 免费域名与 IP 隐私

三档方案，隐私强度递增，都免费：

| 方案 | URL 里有 IP 吗 | dig 能查到源站 IP 吗 | 代价 |
| --- | --- | --- | --- |
| sslip.io / nip.io | **有**（IP 就是域名的一部分） | 能 | 零配置，开箱即用 |
| DuckDNS 等免费二级域名 | 没有 | 能 | 注册一个账号拿 token，2 分钟 |
| Cloudflare 橙云代理 | 没有 | **不能**（只看得到 Cloudflare 的 IP） | 需要一个域名并把 NS 托管过去 |

**默认（sslip.io）**：`dazi.<你的IP>.sslip.io` 自动解析到对应 IP，不用注册不用配 DNS。
缺点是把服务器地址写在了 URL 上，脚本会就此给出警告。

**DuckDNS**（推荐）：去 [duckdns.org](https://www.duckdns.org) 用 GitHub 登录，
起一个子域名并复制 token，然后：

```bash
# campus-dazi 换成你自己起的名字，token 换成 duckdns.org 页面顶部那一串 UUID
sudo DAZI_DUCKDNS_DOMAIN=campus-dazi \
     DAZI_DUCKDNS_TOKEN=a1b2c3d4-e5f6-7890-abcd-ef1234567890 \
     bash deploy/install.sh
```

> 这两个值必须是**真实值**。直接把示例里的中文占位符粘上去，DuckDNS 只会回一个 `KO`，
> 所以脚本会先做格式校验并告诉你该去哪儿拿。

脚本会注册 `campus-dazi.duckdns.org → 你的 IP`，并装一个每 30 分钟刷新的定时任务，
换 IP 也能自动跟上。

**Cloudflare 代理**（唯一能真正隐藏源站 IP 的做法）：把域名托管到 Cloudflare，
A 记录指向服务器并打开橙色云朵，然后用该域名部署：

```bash
sudo DAZI_DOMAIN=dazi.example.com DAZI_SKIP_TLS=1 bash deploy/install.sh
```

（证书交给 Cloudflare 签，所以跳过 certbot；记得在 Cloudflare 把 SSL 模式设为 Flexible，
或者保留 certbot 并设为 Full。）另外别忘了在云厂商安全组里只放行 Cloudflare 的回源 IP 段，
否则别人拿到真实 IP 仍能绕过代理直连。

想换成自己的任意域名：

```bash
sudo DAZI_DOMAIN=dazi.example.com bash deploy/install.sh
```

### 配置邮件提醒

发信走 SMTP，用 QQ / 网易邮箱的**授权码**最省事（不是登录密码）：
邮箱设置 → 账户 → 开启 SMTP 服务 → 生成授权码。

```bash
# 下面的地址和授权码换成你自己的
sudo DAZI_SMTP_HOST=smtp.qq.com \
     DAZI_SMTP_PORT=465 \
     DAZI_SMTP_USER=123456@qq.com \
     DAZI_SMTP_PASS=你生成的16位授权码 \
     bash deploy/install.sh
```

凭据会写进 `/etc/dazi.env`（权限 600），**不会**写进所有人可读的 systemd unit。
重复部署时不带 SMTP 参数的话，脚本会保留上次配好的值。

| 变量 | 说明 |
| --- | --- |
| `DAZI_SMTP_HOST` / `DAZI_SMTP_PORT` | 服务器地址与端口。465 走隐式 TLS，587/25 走 STARTTLS |
| `DAZI_SMTP_USER` / `DAZI_SMTP_PASS` | 账号与授权码 |
| `DAZI_SMTP_FROM` | 发信地址，默认同 USER |
| `DAZI_SMTP_FROM_NAME` | 发件人显示名，默认「校园搭子」 |
| `DAZI_NOTIFY_DWELL_MS` | 停留门槛，默认 1800000（30 分钟） |
| `DAZI_NOTIFY_MIN_MESSAGES` | 发言条数门槛，默认 1 |

### 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `DAZI_DOMAIN` | `dazi.<IP>.sslip.io` | 站点域名 |
| `DAZI_PORT` | 自动挑空闲端口 | 应用监听的本地端口 |
| `DAZI_DATA_DIR` | `/var/lib/dazi` | 数据目录 |
| `DAZI_SECRET` | 首次启动随机生成并存盘 | 身份 Cookie 的签名密钥 |
| `DAZI_SKIP_TLS` | `0` | 设为 `1` 跳过证书申请 |
| `DAZI_EMAIL` | `admin@<域名>` | Let's Encrypt 通知邮箱 |
| `DAZI_DUCKDNS_DOMAIN` | 空 | DuckDNS 子域名，填了就用它换掉 sslip.io |
| `DAZI_DUCKDNS_TOKEN` | 空 | DuckDNS 的 token |
| `DAZI_SITE_URL` | `https://<域名>` | 提醒邮件里链接用的站点地址，由脚本自动写入 |
| `DAZI_ADMIN_USER` | 空 | 管理员用户名，启动时自动创建或提升 |
| `DAZI_ADMIN_PASS` | 空 | 管理员密码，和上一项一起用 |
| `DAZI_REQUIRE_LOGIN` | `0` | 设为 `1` 则必须注册登录才能发帖 / 发言 |

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
| GET | `/api/meta` | 分类、招募状态、排序方式、预设项目、限制、提醒规则 |
| GET | `/api/me` | 取当前身份（没有则当场签发） |
| POST | `/api/auth/register` | 给当前身份绑定账号密码 |
| POST | `/api/auth/login` | 登录，把本浏览器指向该账号 |
| POST | `/api/auth/logout` | 退出，回到新的匿名身份 |
| POST | `/api/auth/password` | 改密码（校验原密码） |
| GET | `/api/admin/overview` | 管理员：站点概览 |
| GET | `/api/admin/users` | 管理员：用户列表，支持 `q` |
| POST | `/api/admin/users/:uid/ban` | 管理员：封禁 / 解封 |
| POST | `/api/admin/users/:uid/role` | 管理员：设为 / 取消管理员 |
| GET | `/api/admin/posts` | 管理员：帖子列表 |
| DELETE | `/api/admin/posts/:id/messages/:msgId` | 管理员：删除单条消息 |
| PATCH | `/api/me` | 改昵称 / 头像 / 底色 / 提醒邮箱（昵称唯一） |
| POST | `/api/me/recovery` | 重新生成身份口令 |
| POST | `/api/session/restore` | 用身份口令在新设备上找回身份 |
| GET | `/api/posts` | 帖子卡片，支持 `category` / `q` / `mine` / `state` / `sort` |
| POST | `/api/posts` | 发帖 |
| GET | `/api/posts/:id` | 详情（锁帖时对外人只返回壳） |
| PATCH | `/api/posts/:id` | 发起人改信息 / 锁帖 / 标记完成 |
| DELETE | `/api/posts/:id` | 发起人删帖 |
| POST | `/api/posts/:id/join` | 加入（可带 `code` 走暗号） |
| POST | `/api/posts/:id/leave` | 退出 |
| POST | `/api/posts/:id/vote` | 改投别的项目 |
| POST | `/api/posts/:id/messages` | 在帖子里发言 |
| POST | `/api/posts/:id/kick` | 发起人移出成员 |
| GET | `/api/stream` | 首页实时流（SSE，同时用于在线判定） |
| GET | `/api/posts/:id/stream` | 帖子实时流（SSE，锁帖后外人 403） |
| GET | `/healthz` | 健康检查 |

---

## 安全边界

- 身份 Cookie 用 HMAC-SHA256 签名，`httpOnly` + `SameSite=Lax`，HTTPS 下自动加 `Secure`；
- 锁帖的内容在**序列化阶段**就被裁掉，接口层面拿不到，不依赖前端隐藏；
- 所有写操作校验发起人 / 成员身份；
- 发帖 10 条/小时、发言 20 条/分钟的限流；
- 前端一律用 `textContent` 渲染用户输入，不拼 HTML；
- 提醒邮箱与用户名只存服务端，`publicUser` 不含这些字段，接口不会返回给别人；
- 密码用 scrypt 加盐哈希，`timingSafeEqual` 比对，哈希从不出现在任何响应里；
- 管理接口统一在入口校验 `role === 'admin'`，匿名和普通用户一律 403；
- SMTP 凭据放 `/etc/dazi.env`（600），不写进所有人可读的 systemd unit；
- 静态文件服务做了目录穿越防护；
- systemd 以专用账号运行，`ProtectSystem=strict`，只有数据目录可写。

## License

MIT
