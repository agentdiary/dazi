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

PUBLIC_IP="${DAZI_IP:-$(curl -fsS --max-time 8 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')}"
DOMAIN="${DAZI_DOMAIN:-${APP_NAME}.${PUBLIC_IP}.sslip.io}"
EMAIL="${DAZI_EMAIL:-admin@${DOMAIN}}"

# 挑一个没被占用的本地端口，避免和服务器上已有的服务撞车
pick_port() {
  local candidate
  for candidate in 8088 8089 8090 8091 8092 8093; do
    if ! (ss -ltn 2>/dev/null || netstat -ltn 2>/dev/null) | grep -q ":${candidate} "; then
      echo "$candidate"; return
    fi
  done
  echo 8099
}
PORT="${DAZI_PORT:-$(pick_port)}"

log "域名     : ${DOMAIN}"
log "公网 IP  : ${PUBLIC_IP}"
log "本地端口 : ${PORT}"

# ---------------------------------------------------------------- 依赖

need_node() {
  command -v node >/dev/null 2>&1 || return 0
  local major
  major="$(node -v | sed 's/^v\([0-9]*\).*/\1/')"
  [[ "$major" -lt 18 ]]
}

export DEBIAN_FRONTEND=noninteractive

if need_node; then
  log "安装 Node.js…"
  apt-get update -qq
  apt-get install -y -qq nodejs || true
  if need_node; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y -qq nodejs
  fi
fi
log "Node.js $(node -v)"

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
ExecStart=$(command -v node) ${APP_DIR}/server/index.js
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
