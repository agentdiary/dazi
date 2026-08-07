#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# 校园搭子 · 一键部署（Ubuntu / Debian）
#
#   sudo bash deploy/install.sh
#
# 做的事：
#   1. 确保 Node.js >= 18
#   2. 把代码安装到 /opt/dazi，数据放 /var/lib/dazi（升级不会丢数据）
#   3. 注册 systemd 服务 dazi.service，监听 127.0.0.1 上的私有端口
#   4. 加一个 nginx 站点（只新增 server 块，不动服务器上已有的站点）
#   5. 尝试用 certbot 给免费域名签 HTTPS 证书，失败则保持 HTTP 可用
#
# 免费域名：默认用 sslip.io —— 形如 dazi.<你的IP>.sslip.io 的域名会自动解析
# 到对应 IP，不用注册、不用配置 DNS、永久免费。想换成自己的域名，
# 部署前设置环境变量 DAZI_DOMAIN=example.com 即可。
# ---------------------------------------------------------------------------
set -euo pipefail

APP_NAME=dazi
APP_DIR=/opt/${APP_NAME}
DATA_DIR=/var/lib/${APP_NAME}
SERVICE_USER=${APP_NAME}
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

log()  { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m警告:\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m错误:\033[0m %s\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "请用 root 运行：sudo bash deploy/install.sh"

# ---------------------------------------------------------------- 域名与端口

# 云主机常常是 NAT 出网（网卡上只有内网地址），所以优先问外部服务要公网 IP。
detect_ip() {
  local ip svc
  for svc in https://api.ipify.org https://ifconfig.me/ip https://ipinfo.io/ip; do
    ip="$(curl -fsS --max-time 6 "$svc" 2>/dev/null | tr -d '[:space:]')" || true
    [[ "$ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] && { echo "$ip"; return; }
  done
  hostname -I | awk '{print $1}'
}

PUBLIC_IP="${DAZI_IP:-$(detect_ip)}"
if [[ "$PUBLIC_IP" =~ ^(10\.|127\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.) && -z "${DAZI_DOMAIN:-}" ]]; then
  warn "探测到的 ${PUBLIC_IP} 是内网地址，用它拼出来的免费域名在公网上解析不到。"
  warn "请改用：sudo DAZI_DOMAIN=<你的域名> bash deploy/install.sh"
fi

# DuckDNS：免费二级域名，URL 里不出现 IP。
# 用法：sudo DAZI_DUCKDNS_DOMAIN=campus-dazi DAZI_DUCKDNS_TOKEN=xxx bash deploy/install.sh
setup_duckdns() {
  local sub="${DAZI_DUCKDNS_DOMAIN%%.duckdns.org}"

  # 先挡住「把示例里的占位符原样粘贴进来」这种最常见的情况，
  # 否则要等 DuckDNS 回一个光秃秃的 KO 才知道哪里错了。
  if [[ ! "$sub" =~ ^[A-Za-z0-9][A-Za-z0-9-]{0,62}$ ]]; then
    die "DuckDNS 子域名「${sub}」不合法：只能用英文字母、数字和连字符。
     看起来你把示例里的占位符直接粘贴进来了。请先去 https://www.duckdns.org
     用 GitHub 登录，自己起一个名字（比如 campus-dazi）并复制页面顶部的 token，
     然后把 DAZI_DUCKDNS_DOMAIN 和 DAZI_DUCKDNS_TOKEN 换成真实值再运行。
     不想现在弄域名的话，把这两个变量去掉即可，会用免费的 sslip.io。"
  fi
  if [[ ! "${DAZI_DUCKDNS_TOKEN}" =~ ^[A-Za-z0-9-]{8,}$ ]]; then
    die "DuckDNS token 看起来不是真实值（应该是一串 UUID，形如 a1b2c3d4-....）。
     请到 https://www.duckdns.org 页面顶部复制你的 token。"
  fi

  log "向 DuckDNS 注册 ${sub}.duckdns.org → ${PUBLIC_IP}"
  local answer curl_status=0
  answer="$(curl -fsS --max-time 20 \
    "https://www.duckdns.org/update?domains=${sub}&token=${DAZI_DUCKDNS_TOKEN}&ip=${PUBLIC_IP}")" || curl_status=$?

  if [[ $curl_status -ne 0 ]]; then
    die "连不上 duckdns.org（curl 退出码 ${curl_status}）。
     这台服务器可能访问不了 DuckDNS。可以先不用它，改成：
       sudo DAZI_DOMAIN=${APP_NAME}.${PUBLIC_IP}.sslip.io bash deploy/install.sh
     或者用一个能正常解析的自有域名。"
  fi
  if [[ "$answer" != OK ]]; then
    die "DuckDNS 拒绝了这次更新（返回：${answer}）。
     KO 一般意味着 token 不对，或这个子域名不在你的账号名下。
     token 在 https://www.duckdns.org 页面顶部，形如 a1b2c3d4-e5f6-7890-abcd-ef1234567890。"
  fi

  # IP 变了要能自动跟上，挂个定时任务每 30 分钟刷一次
  cat > /etc/cron.d/${APP_NAME}-duckdns <<CRON
# 校园搭子：保持 DuckDNS 记录指向当前公网 IP
*/30 * * * * root curl -fsS "https://www.duckdns.org/update?domains=${sub}&token=${DAZI_DUCKDNS_TOKEN}&ip=" >/dev/null 2>&1
CRON
  chmod 600 /etc/cron.d/${APP_NAME}-duckdns
  echo "${sub}.duckdns.org"
}

if [[ -n "${DAZI_DUCKDNS_DOMAIN:-}" && -n "${DAZI_DUCKDNS_TOKEN:-}" ]]; then
  DOMAIN="$(setup_duckdns)"
else
  DOMAIN="${DAZI_DOMAIN:-${APP_NAME}.${PUBLIC_IP}.sslip.io}"
fi
EMAIL="${DAZI_EMAIL:-admin@${DOMAIN}}"

if [[ "$DOMAIN" == *.sslip.io || "$DOMAIN" == *.nip.io ]]; then
  warn "当前域名把服务器 IP 直接写在了 URL 里（${DOMAIN}）。"
  warn "想让 URL 里不出现 IP，可以用免费的 DuckDNS："
  warn "  sudo DAZI_DUCKDNS_DOMAIN=<你起的名字> DAZI_DUCKDNS_TOKEN=<token> bash deploy/install.sh"
  warn "注意：换域名只是让 URL 不带 IP，dig 一下仍能查到解析目标。"
  warn "要彻底隐藏源站 IP，需要在前面套一层 Cloudflare 代理，详见 README。"
fi

# 端口：已经部署过就沿用原端口（避免重复部署时端口漂移），
# 否则挑一个没被占用的，避免和服务器上已有的服务撞车。
existing_port() {
  local unit=/etc/systemd/system/${APP_NAME}.service
  [[ -f $unit ]] || return 1
  sed -n 's/^Environment=DAZI_PORT=\([0-9]\+\)$/\1/p' "$unit" | head -1 | grep -q . || return 1
  sed -n 's/^Environment=DAZI_PORT=\([0-9]\+\)$/\1/p' "$unit" | head -1
}

pick_port() {
  local candidate
  for candidate in 8088 8089 8090 8091 8092 8093; do
    if ! (ss -ltn 2>/dev/null || netstat -ltn 2>/dev/null) | grep -q ":${candidate} "; then
      echo "$candidate"; return
    fi
  done
  echo 8099
}
PORT="${DAZI_PORT:-$(existing_port || pick_port)}"

log "域名     : ${DOMAIN}"
log "公网 IP  : ${PUBLIC_IP}"
log "本地端口 : ${PORT}"

# ---------------------------------------------------------------- 依赖

# Node.js。这台机器上可能已经跑着别的项目，所以绝不去动系统里已有的 node：
#   1. 系统 node 够新（>=18）就直接用；
#   2. 不够新或者没装，就把官方绿色版解到 /opt/dazi-runtime 里私有使用，
#      不改 PATH、不覆盖 /usr/bin/node —— 别的项目的环境保持原样。
NODE_LTS=v24.19.0
RUNTIME_DIR=/opt/${APP_NAME}-runtime

node_major() { "$1" -v 2>/dev/null | sed 's/^v\([0-9]*\).*/\1/'; }

resolve_node() {
  local sys major
  sys="$(command -v node || true)"
  if [[ -n "$sys" ]]; then
    major="$(node_major "$sys")"
    if [[ -n "$major" && "$major" -ge 18 ]]; then
      log "复用系统已有的 Node.js $("$sys" -v)（不做任何改动）"
      NODE_BIN="$sys"; return
    fi
    warn "系统 Node.js 是 $("$sys" -v)，低于 18；不升级它，改用本项目私有的运行时。"
  fi

  # 已经装过私有运行时就直接复用
  if [[ -x "${RUNTIME_DIR}/bin/node" ]] && [[ "$(node_major "${RUNTIME_DIR}/bin/node")" -ge 18 ]]; then
    log "复用私有 Node.js $("${RUNTIME_DIR}/bin/node" -v)"
    NODE_BIN="${RUNTIME_DIR}/bin/node"; return
  fi

  local arch
  case "$(uname -m)" in
    x86_64)  arch=x64 ;;
    aarch64) arch=arm64 ;;
    armv7l)  arch=armv7l ;;
    *) die "不认识的 CPU 架构 $(uname -m)，请手动装好 Node.js >= 18 后重跑" ;;
  esac

  log "下载 Node.js ${NODE_LTS}-linux-${arch} 到 ${RUNTIME_DIR}（不影响系统 node）…"
  local tarball=/tmp/node-${NODE_LTS}-${arch}.tar.xz
  local url="https://nodejs.org/dist/${NODE_LTS}/node-${NODE_LTS}-linux-${arch}.tar.xz"
  local mirror="https://mirrors.tuna.tsinghua.edu.cn/nodejs-release/${NODE_LTS}/node-${NODE_LTS}-linux-${arch}.tar.xz"

  command -v xz >/dev/null 2>&1 || apt-get install -y -qq xz-utils
  if ! curl -fsSL --max-time 180 "$url" -o "$tarball"; then
    warn "nodejs.org 下载失败，改用清华镜像…"
    curl -fsSL --max-time 180 "$mirror" -o "$tarball" \
      || die "Node.js 下载失败，请检查服务器出网，或手动装好 Node >= 18 后重跑"
  fi

  rm -rf "$RUNTIME_DIR" && mkdir -p "$RUNTIME_DIR"
  tar -xJf "$tarball" -C "$RUNTIME_DIR" --strip-components=1
  rm -f "$tarball"
  NODE_BIN="${RUNTIME_DIR}/bin/node"
  [[ -x "$NODE_BIN" ]] || die "Node.js 解压后没找到可执行文件"
  log "私有 Node.js $("$NODE_BIN" -v) 就绪"
}

export DEBIAN_FRONTEND=noninteractive
resolve_node

command -v nginx >/dev/null 2>&1 || { log "安装 nginx…"; apt-get install -y -qq nginx; }
command -v rsync >/dev/null 2>&1 || apt-get install -y -qq rsync

# ---------------------------------------------------------------- 应用文件

id -u "$SERVICE_USER" >/dev/null 2>&1 || {
  log "创建服务账号 ${SERVICE_USER}"
  useradd --system --home "$DATA_DIR" --shell /usr/sbin/nologin "$SERVICE_USER"
}

log "同步代码到 ${APP_DIR}"
mkdir -p "$APP_DIR" "$DATA_DIR"
rsync -a --delete \
  --exclude '.git' --exclude 'data' --exclude 'node_modules' --exclude '.github' \
  "$REPO_DIR"/ "$APP_DIR"/
chown -R root:root "$APP_DIR"
# 注意：rsync -a 会把源目录自身的权限也同步过来。如果是从 mktemp -d（0700）
# 建的目录部署的，/opt/dazi 会变成 root 独占，服务账号连 chdir 都进不去
# （systemd 报 status=200/CHDIR）。所以这里显式规范化：目录 755、文件 644。
chmod -R u=rwX,go=rX "$APP_DIR"
if [[ -d "$RUNTIME_DIR" ]]; then chmod -R u=rwX,go=rX "$RUNTIME_DIR"; fi
chown -R "$SERVICE_USER":"$SERVICE_USER" "$DATA_DIR"
chmod 750 "$DATA_DIR"

# 起服务之前先确认服务账号真的进得去、读得到，别等 systemd 报 200/CHDIR 才发现
if ! runuser -u "$SERVICE_USER" -- test -x "$APP_DIR"; then
  die "服务账号 ${SERVICE_USER} 无法进入 ${APP_DIR}（权限 $(stat -c %a "$APP_DIR")）"
fi
if ! runuser -u "$SERVICE_USER" -- test -r "${APP_DIR}/server/index.js"; then
  die "服务账号 ${SERVICE_USER} 读不到 ${APP_DIR}/server/index.js"
fi
if ! runuser -u "$SERVICE_USER" -- "$NODE_BIN" -e 'process.exit(0)'; then
  die "服务账号 ${SERVICE_USER} 执行不了 ${NODE_BIN}"
fi

# ---------------------------------------------------------------- systemd

# 站点地址 + SMTP 凭据单独放一个 600 的环境文件，不写进 systemd unit（unit 是所有人可读的）
ENV_FILE=/etc/${APP_NAME}.env
SCHEME=https
[[ "${DAZI_SKIP_TLS:-0}" == "1" ]] && SCHEME=http

if [[ -n "${DAZI_SMTP_USER:-}" && ! "${DAZI_SMTP_USER}" =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]]; then
  die "DAZI_SMTP_USER「${DAZI_SMTP_USER}」不是一个合法邮箱地址。
     看起来是示例里的占位符。QQ 邮箱请填完整地址（如 123456@qq.com），
     密码填「SMTP 授权码」而不是登录密码：QQ邮箱 → 设置 → 账户 → 开启 SMTP → 生成授权码。
     暂时不配邮件提醒的话，把 DAZI_SMTP_* 几个变量都去掉即可。"
fi

log "写入环境文件 ${ENV_FILE}"
if [[ -f "$ENV_FILE" && -z "${DAZI_SMTP_HOST:-}" ]]; then
  # 重复部署且这次没给 SMTP 参数：保留上次配好的，只更新站点地址
  sed -i "/^DAZI_SITE_URL=/d" "$ENV_FILE"
  echo "DAZI_SITE_URL=${SCHEME}://${DOMAIN}" >> "$ENV_FILE"
else
  {
    echo "DAZI_SITE_URL=${SCHEME}://${DOMAIN}"
    [[ -n "${DAZI_SMTP_HOST:-}" ]]      && echo "DAZI_SMTP_HOST=${DAZI_SMTP_HOST}"
    [[ -n "${DAZI_SMTP_PORT:-}" ]]      && echo "DAZI_SMTP_PORT=${DAZI_SMTP_PORT}"
    [[ -n "${DAZI_SMTP_USER:-}" ]]      && echo "DAZI_SMTP_USER=${DAZI_SMTP_USER}"
    [[ -n "${DAZI_SMTP_PASS:-}" ]]      && echo "DAZI_SMTP_PASS=${DAZI_SMTP_PASS}"
    [[ -n "${DAZI_SMTP_FROM:-}" ]]      && echo "DAZI_SMTP_FROM=${DAZI_SMTP_FROM}"
    [[ -n "${DAZI_SMTP_FROM_NAME:-}" ]] && echo "DAZI_SMTP_FROM_NAME=${DAZI_SMTP_FROM_NAME}"
    [[ -n "${DAZI_SMTP_SECURE:-}" ]]    && echo "DAZI_SMTP_SECURE=${DAZI_SMTP_SECURE}"
    true
  } > "$ENV_FILE"
fi
chmod 600 "$ENV_FILE"
if grep -q '^DAZI_SMTP_HOST=' "$ENV_FILE"; then
  log "邮件提醒：已配置 $(sed -n 's/^DAZI_SMTP_HOST=//p' "$ENV_FILE")"
else
  log "邮件提醒：未配置 SMTP（站内提醒照常工作）"
fi

log "写入 systemd 服务"
cat > /etc/systemd/system/${APP_NAME}.service <<UNIT
[Unit]
Description=校园搭子 (dazi) - 看板风格校园搭子社交
Documentation=https://github.com/agentdiary/dazi
After=network.target

[Service]
Type=simple
User=${SERVICE_USER}
Group=${SERVICE_USER}
WorkingDirectory=${APP_DIR}
Environment=NODE_ENV=production
Environment=DAZI_HOST=127.0.0.1
Environment=DAZI_PORT=${PORT}
Environment=DAZI_DATA_DIR=${DATA_DIR}
EnvironmentFile=-${ENV_FILE}
ExecStart=${NODE_BIN} ${APP_DIR}/server/index.js
Restart=always
RestartSec=3

# 加固：只允许写数据目录
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=${DATA_DIR}

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now ${APP_NAME}
sleep 1
systemctl restart ${APP_NAME}
sleep 1

if ! curl -fsS --max-time 5 "http://127.0.0.1:${PORT}/healthz" >/dev/null; then
  journalctl -u ${APP_NAME} -n 30 --no-pager || true
  die "服务启动失败，日志见上"
fi
log "服务已启动：$(curl -s http://127.0.0.1:${PORT}/healthz)"

# ---------------------------------------------------------------- nginx

log "配置 nginx 站点 ${DOMAIN}"
cat > /etc/nginx/sites-available/${APP_NAME} <<NGINX
server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN};

    # 让 certbot 的 HTTP-01 校验能过
    location /.well-known/acme-challenge/ { root /var/www/html; }

    location / {
        proxy_pass http://127.0.0.1:${PORT};
        proxy_http_version 1.1;
        proxy_set_header Host              \$host;
        proxy_set_header X-Real-IP         \$remote_addr;
        proxy_set_header X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Connection        '';

        # SSE：实时聊天/看板推送必须关掉缓冲，并放长超时
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        chunked_transfer_encoding on;
    }
}
NGINX

ln -sfn /etc/nginx/sites-available/${APP_NAME} /etc/nginx/sites-enabled/${APP_NAME}
nginx -t
systemctl reload nginx
log "HTTP 已就绪：http://${DOMAIN}"

# ---------------------------------------------------------------- HTTPS

if [[ "${DAZI_SKIP_TLS:-0}" != "1" ]]; then
  command -v certbot >/dev/null 2>&1 || { log "安装 certbot…"; apt-get install -y -qq certbot python3-certbot-nginx; }
  log "申请 Let's Encrypt 证书…"
  if certbot --nginx -d "${DOMAIN}" --non-interactive --agree-tos -m "${EMAIL}" --redirect; then
    systemctl reload nginx
    log "HTTPS 已就绪：https://${DOMAIN}"
  else
    warn "证书申请失败（80 端口不通 / 域名解析没生效 / 触发速率限制都可能导致）。"
    warn "站点仍可通过 http://${DOMAIN} 访问，稍后可重试：certbot --nginx -d ${DOMAIN}"
  fi
fi

echo
log "部署完成 🎉"
echo "   站点     : https://${DOMAIN}"
echo "   服务状态 : systemctl status ${APP_NAME}"
echo "   实时日志 : journalctl -u ${APP_NAME} -f"
echo "   数据目录 : ${DATA_DIR}  （dazi.json 是全部数据，直接复制即可备份）"
