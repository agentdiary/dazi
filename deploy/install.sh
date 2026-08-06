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
  warn "请改用：sudo DAZI_DOMAIN=${APP_NAME}.<你的公网IP>.sslip.io bash deploy/install.sh"
fi
DOMAIN="${DAZI_DOMAIN:-${APP_NAME}.${PUBLIC_IP}.sslip.io}"
EMAIL="${DAZI_EMAIL:-admin@${DOMAIN}}"

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
chown -R "$SERVICE_USER":"$SERVICE_USER" "$DATA_DIR"
chmod 750 "$DATA_DIR"

# ---------------------------------------------------------------- systemd

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
