#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# 在这台服务器上装一个 OpenClaw，模型接自己的 Kimi（Ubuntu / Debian）
#
#   sudo OPENCLAW_KIMI_KEY=sk-xxx OPENCLAW_TG_TOKEN=123:abc \
#        bash deploy/openclaw.sh
#
# 做的事：
#   1. 备一份私有 Node 运行时（OpenClaw 要 Node >= 22.22.3，不动系统 node）
#   2. 用独立系统账号 openclaw 装到 /opt/openclaw，数据放 /var/lib/openclaw
#   3. 写 ~/.config/openclaw/openclaw.json：Kimi 作为自定义 provider + Telegram 通道
#   4. 注册 systemd 服务 openclaw.service，网关只监听 127.0.0.1
#   5. 起服务之前先拿真实凭据探一次 Kimi 和 Telegram，错了当场就报
#
# 这台机器上还跑着「校园搭子」的生产站点，所以这个脚本刻意做了隔离：
# 独立账号、独立运行时、systemd 把 /var/lib/dazi 和 /etc/dazi.env 设成不可见、
# 只有自己的数据目录可写、网关不开公网端口（要用就 SSH 隧道）。
#
# 装完之后 OpenClaw 仍然是一个「能执行命令的 agent」，只是被关在 openclaw
# 这个账号和它自己的目录里。想更紧就把 OPENCLAW_TOOLS 设成 minimal。
# ---------------------------------------------------------------------------
set -euo pipefail

APP_NAME=openclaw
APP_DIR=/opt/${APP_NAME}                 # npm 全局前缀，只读即可
DATA_DIR=/var/lib/${APP_NAME}            # HOME、配置、工作区，唯一可写的地方
RUNTIME_DIR=/opt/${APP_NAME}-runtime     # 私有 Node，不碰系统 node
SERVICE_USER=${APP_NAME}
ENV_FILE=/etc/${APP_NAME}.env
CONFIG_DIR=${DATA_DIR}/.config/${APP_NAME}
CONFIG_FILE=${CONFIG_DIR}/${APP_NAME}.json

# 诊断信息一律走 stderr，理由同 deploy/install.sh：命令替换只该捕获返回值。
log()  { printf '\033[1;36m==>\033[0m %s\n' "$*" >&2; }
warn() { printf '\033[1;33m警告:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m错误:\033[0m %s\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "请用 root 运行：sudo bash deploy/openclaw.sh"

# ------------------------------------------------------- 沿用上次的设置

# 和 dazi 一样的规矩：这次给了就用新的，没给就沿用上次记住的。
# 这样重跑一次不带参数的脚本只是升级 + 重启，不会把 key 或 token 弄丢。
prev_setting() {
  [[ -f "$ENV_FILE" ]] || return 0
  sed -n "s/^$1=//p" "$ENV_FILE" | head -1
}

for key in OPENCLAW_KIMI_KEY OPENCLAW_BASE_URL OPENCLAW_MODEL OPENCLAW_VERSION \
           OPENCLAW_TG_TOKEN OPENCLAW_TG_ALLOW OPENCLAW_PORT OPENCLAW_TOOLS; do
  if [[ -z "${!key:-}" ]]; then
    value="$(prev_setting "$key")"
    [[ -n "$value" ]] && export "$key=$value"
  fi
done
unset key value

KIMI_KEY="${OPENCLAW_KIMI_KEY:-}"
BASE_URL="${OPENCLAW_BASE_URL:-https://api.moonshot.ai/v1}"
MODEL_ID="${OPENCLAW_MODEL:-kimi-k2.7-code}"
OC_VERSION="${OPENCLAW_VERSION:-latest}"
TG_TOKEN="${OPENCLAW_TG_TOKEN:-}"
TG_ALLOW="${OPENCLAW_TG_ALLOW:-}"
PORT="${OPENCLAW_PORT:-18789}"
TOOL_PROFILE="${OPENCLAW_TOOLS:-coding}"

[[ -n "$KIMI_KEY" ]] || die "还没有 Kimi 的 API key。到 https://platform.kimi.ai 申请一个，然后：
     sudo OPENCLAW_KIMI_KEY=sk-xxx OPENCLAW_TG_TOKEN=<BotFather 给的 token> bash deploy/openclaw.sh"

# 境内机器连 api.moonshot.ai 会很慢甚至不通，反过来也一样。这里只提醒，不擅自改。
if [[ "$BASE_URL" != */v1 && "$BASE_URL" != */anthropic ]]; then
  warn "OPENCLAW_BASE_URL=${BASE_URL} 结尾既不是 /v1 也不是 /anthropic，八成写错了。"
  warn "OpenAI 兼容用 https://api.moonshot.ai/v1，Anthropic 兼容用 https://api.moonshot.ai/anthropic。"
fi

case "$TOOL_PROFILE" in
  minimal|coding|messaging|full) ;;
  *) die "OPENCLAW_TOOLS 只能是 minimal / coding / messaging / full，收到「${TOOL_PROFILE}」" ;;
esac
[[ "$TOOL_PROFILE" == full ]] && warn "工具策略选了 full：agent 在 openclaw 账号里不受限。生产机上建议 coding 或 minimal。"

# ---------------------------------------------------- 先验凭据，错了当场报

# 装了半天最后卡在「401」是最难受的，所以在动系统之前先拿真凭据探一次。
log "验证 Kimi API key（${BASE_URL}）…"
probe_url="${BASE_URL%/}/models"
[[ "$BASE_URL" == */anthropic ]] && probe_url="${BASE_URL%/}/v1/models"
http_code="$(curl -s -o /tmp/openclaw-probe.json -w '%{http_code}' --max-time 20 \
  -H "Authorization: Bearer ${KIMI_KEY}" "$probe_url" 2>/dev/null || echo 000)"
case "$http_code" in
  200) log "Kimi 连通，key 有效" ;;
  401|403) die "Kimi 拒绝了这个 key（HTTP ${http_code}）。请到 https://platform.kimi.ai 确认 key 是否正确、是否还有额度。
     注意国内站（platform.moonshot.cn / api.moonshot.cn）和国际站（platform.kimi.ai / api.moonshot.ai）
     是两套账号，key 不通用。这台机器在境外，用的是国际站。" ;;
  000) die "连不上 ${probe_url}，服务器出网可能有问题。
     如果这台机器其实在境内，改用国内站重跑：
       sudo OPENCLAW_BASE_URL=https://api.moonshot.cn/v1 bash deploy/openclaw.sh" ;;
  *) warn "探测 Kimi 返回 HTTP ${http_code}，先继续装，但模型可能调不通。" ;;
esac

# 模型名必须和 Kimi 那边一字不差，写错了不是报错而是静默打到别的模型上。
if [[ "$http_code" == 200 ]] && command -v grep >/dev/null; then
  if ! grep -q "\"${MODEL_ID}\"" /tmp/openclaw-probe.json; then
    warn "Kimi 的模型列表里没看到「${MODEL_ID}」。可用的大致是："
    grep -o '"id"[[:space:]]*:[[:space:]]*"[^"]*"' /tmp/openclaw-probe.json \
      | sed 's/.*"\([^"]*\)"$/       \1/' | head -12 >&2 || true
    warn "确认后用 OPENCLAW_MODEL=<正确的名字> 重跑。"
  fi
fi
rm -f /tmp/openclaw-probe.json

if [[ -n "$TG_TOKEN" ]]; then
  log "验证 Telegram bot token…"
  tg_name="$(curl -fsS --max-time 20 "https://api.telegram.org/bot${TG_TOKEN}/getMe" 2>/dev/null \
    | sed -n 's/.*"username":"\([^"]*\)".*/\1/p' | head -1)" || true
  if [[ -n "$tg_name" ]]; then
    log "Telegram bot：@${tg_name}"
  else
    die "Telegram 不认这个 token，或者这台服务器连不上 api.telegram.org。
     token 找 @BotFather 用 /newbot 拿，形如 123456789:AAE...。
     暂时不接 Telegram 的话，把 OPENCLAW_TG_TOKEN 去掉即可，先用本地 CLI。"
  fi
else
  warn "没给 Telegram token，这次只装网关。之后补上："
  warn "  sudo OPENCLAW_TG_TOKEN=<BotFather 给的 token> bash deploy/openclaw.sh"
fi

# ---------------------------------------------------------------- Node 运行时

# OpenClaw 要 Node 22.22.3+ / 24.15+ / 25.9+，比 dazi 的下限高得多。
# 系统 node 是 dazi 在用的，绝不去升级它——不够新就自己下一份放 /opt。
NODE_LTS=v24.19.0

version_ge() { [[ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -1)" == "$2" ]]; }

node_ok() {
  local v
  v="$("$1" -v 2>/dev/null | tr -d 'v')" || return 1
  [[ -n "$v" ]] || return 1
  version_ge "$v" 26.0.0 && return 0
  version_ge "$v" 25.9.0 && [[ "${v%%.*}" == 25 ]] && return 0
  version_ge "$v" 24.15.0 && [[ "${v%%.*}" == 24 ]] && return 0
  version_ge "$v" 22.22.3 && [[ "${v%%.*}" == 22 ]] && return 0
  return 1
}

resolve_node() {
  local sys
  sys="$(command -v node || true)"
  if [[ -n "$sys" ]] && node_ok "$sys"; then
    log "复用系统已有的 Node.js $("$sys" -v)（不做任何改动）"
    NODE_BIN="$sys"; return
  fi
  [[ -n "$sys" ]] && log "系统 Node.js 是 $("$sys" -v)，OpenClaw 用不了；不升级它，另装一份私有的。"

  if [[ -x "${RUNTIME_DIR}/bin/node" ]] && node_ok "${RUNTIME_DIR}/bin/node"; then
    log "复用私有 Node.js $("${RUNTIME_DIR}/bin/node" -v)"
    NODE_BIN="${RUNTIME_DIR}/bin/node"; return
  fi

  local arch
  case "$(uname -m)" in
    x86_64)  arch=x64 ;;
    aarch64) arch=arm64 ;;
    *) die "不认识的 CPU 架构 $(uname -m)，请手动装好 Node.js >= 24.15 后重跑" ;;
  esac

  log "下载 Node.js ${NODE_LTS}-linux-${arch} 到 ${RUNTIME_DIR}（不影响系统 node）…"
  local tarball=/tmp/node-${NODE_LTS}-${arch}.tar.xz
  local url="https://nodejs.org/dist/${NODE_LTS}/node-${NODE_LTS}-linux-${arch}.tar.xz"
  local mirror="https://mirrors.tuna.tsinghua.edu.cn/nodejs-release/${NODE_LTS}/node-${NODE_LTS}-linux-${arch}.tar.xz"

  command -v xz >/dev/null 2>&1 || apt-get install -y -qq xz-utils
  if ! curl -fsSL --max-time 300 "$url" -o "$tarball"; then
    warn "nodejs.org 下载失败，改用清华镜像…"
    curl -fsSL --max-time 300 "$mirror" -o "$tarball" \
      || die "Node.js 下载失败，请检查服务器出网"
  fi

  rm -rf "$RUNTIME_DIR" && mkdir -p "$RUNTIME_DIR"
  tar -xJf "$tarball" -C "$RUNTIME_DIR" --strip-components=1
  rm -f "$tarball"
  NODE_BIN="${RUNTIME_DIR}/bin/node"
  [[ -x "$NODE_BIN" ]] || die "Node.js 解压后没找到可执行文件"
  log "私有 Node.js $("$NODE_BIN" -v) 就绪"
}

export DEBIAN_FRONTEND=noninteractive
command -v curl >/dev/null 2>&1 || apt-get install -y -qq curl
resolve_node
NODE_BIN_DIR="$(dirname "$NODE_BIN")"

# ---------------------------------------------------------------- 账号与目录

id -u "$SERVICE_USER" >/dev/null 2>&1 || {
  log "创建服务账号 ${SERVICE_USER}"
  # 给 /bin/bash 而不是 nologin：agent 的 shell 工具要真能起子进程。
  # 这个账号没有密码、没有 authorized_keys，登不进来，也不在 sudo 组里。
  useradd --system --create-home --home-dir "$DATA_DIR" --shell /bin/bash "$SERVICE_USER"
}

mkdir -p "$DATA_DIR" "$CONFIG_DIR" "${DATA_DIR}/workspace"
chown -R "$SERVICE_USER":"$SERVICE_USER" "$DATA_DIR"
chmod 700 "$DATA_DIR"

# 有的版本读 ~/.openclaw，有的读 XDG 的 ~/.config/openclaw。
# 做个软链两边指同一份，省得版本一升配置就「不见了」。
if [[ ! -e "${DATA_DIR}/.${APP_NAME}" ]]; then
  ln -s "$CONFIG_DIR" "${DATA_DIR}/.${APP_NAME}"
  chown -h "$SERVICE_USER":"$SERVICE_USER" "${DATA_DIR}/.${APP_NAME}"
fi

# ---------------------------------------------------------------- 安装 OpenClaw

log "安装 openclaw@${OC_VERSION} 到 ${APP_DIR}"
mkdir -p "$APP_DIR"
PATH="${NODE_BIN_DIR}:${PATH}" npm_config_prefix="$APP_DIR" \
  npm install -g --no-fund --no-audit "openclaw@${OC_VERSION}" \
  || die "npm 安装 openclaw 失败，上面有 npm 的原始报错"

OC_BIN="${APP_DIR}/bin/${APP_NAME}"
[[ -x "$OC_BIN" ]] || die "装完没找到 ${OC_BIN}"
chmod -R u=rwX,go=rX "$APP_DIR"
log "openclaw $("$OC_BIN" --version 2>/dev/null || echo '(版本号取不到)') 就绪"

# ---------------------------------------------------------------- 写配置

# 用 node 做深合并而不是覆盖：手工在配置里加的东西（额外的 agent、工具策略、
# 其他通道）要留着，这个脚本只负责它自己管的那几个键。
log "写入 ${CONFIG_FILE}"
CFG="$CONFIG_FILE" KIMI_KEY="$KIMI_KEY" BASE_URL="$BASE_URL" MODEL_ID="$MODEL_ID" \
TG_TOKEN="$TG_TOKEN" TG_ALLOW="$TG_ALLOW" TOOL_PROFILE="$TOOL_PROFILE" \
"$NODE_BIN" <<'NODEJS'
const fs = require('fs');
const path = require('path');
const file = process.env.CFG;

let current = {};
if (fs.existsSync(file)) {
  try {
    current = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    // 可能是带注释的 JSON5，也可能是上次写坏了。不猜，备份走人。
    const backup = `${file}.bak.${Date.now()}`;
    fs.copyFileSync(file, backup);
    console.error(`警告: 现有配置解析不了（${err.message}），已备份到 ${backup}，本次重新生成`);
    current = {};
  }
}

const api = process.env.BASE_URL.endsWith('/anthropic')
  ? 'anthropic-messages'
  : 'openai-completions';

const telegram = process.env.TG_TOKEN
  ? {
      enabled: true,
      botToken: process.env.TG_TOKEN,
      // 没给 numeric id 就走配对：启动后 openclaw pairing approve 一下即可，
      // 比让人先去查自己的 Telegram user id 省事，而且默认不是对所有人开放。
      dmPolicy: process.env.TG_ALLOW ? 'allowlist' : 'pairing',
      ...(process.env.TG_ALLOW
        ? { allowFrom: process.env.TG_ALLOW.split(',').map((s) => s.trim()).filter(Boolean) }
        : {}),
      groupPolicy: 'disabled',
    }
  : { enabled: false };

const managed = {
  agents: {
    defaults: {
      model: { primary: `kimi/${process.env.MODEL_ID}` },
      tools: { profile: process.env.TOOL_PROFILE },
    },
  },
  models: {
    mode: 'merge',
    providers: {
      kimi: {
        baseUrl: process.env.BASE_URL,
        apiKey: process.env.KIMI_KEY,
        api,
        timeoutSeconds: 300,
        models: [
          {
            id: process.env.MODEL_ID,
            name: `Kimi (${process.env.MODEL_ID})`,
            reasoning: true,
            input: ['text'],
            contextWindow: 262144,
            maxTokens: 16384,
          },
        ],
      },
    },
  },
  channels: { telegram },
};

// 标量和数组由 managed 覆盖，对象递归合并。
const merge = (base, patch) => {
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      base[k] = merge(base[k] && typeof base[k] === 'object' ? base[k] : {}, v);
    } else {
      base[k] = v;
    }
  }
  return base;
};

const result = merge(current, managed);

// 深合并只增不删。从 allowlist 切回 pairing 时，上次那份 allowFrom 会留在文件里，
// 于是「已经不在名单上的人」实际还进得来——这里显式清掉。
if (process.env.TG_TOKEN && !process.env.TG_ALLOW) {
  delete result.channels.telegram.allowFrom;
}

fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
NODEJS

chown "$SERVICE_USER":"$SERVICE_USER" "$CONFIG_FILE"
chmod 600 "$CONFIG_FILE"

# 记住这次的设置，下次不带参数重跑就是纯升级。key 和 token 都在里面，所以 600。
log "写入环境文件 ${ENV_FILE}"
{
  echo "OPENCLAW_KIMI_KEY=${KIMI_KEY}"
  echo "OPENCLAW_BASE_URL=${BASE_URL}"
  echo "OPENCLAW_MODEL=${MODEL_ID}"
  echo "OPENCLAW_VERSION=${OC_VERSION}"
  echo "OPENCLAW_PORT=${PORT}"
  echo "OPENCLAW_TOOLS=${TOOL_PROFILE}"
  [[ -n "$TG_TOKEN" ]] && echo "OPENCLAW_TG_TOKEN=${TG_TOKEN}"
  [[ -n "$TG_ALLOW" ]] && echo "OPENCLAW_TG_ALLOW=${TG_ALLOW}"
  true
} > "$ENV_FILE"
chmod 600 "$ENV_FILE"

# ---------------------------------------------------------------- systemd

log "写入 systemd 服务"
cat > /etc/systemd/system/${APP_NAME}.service <<UNIT
[Unit]
Description=OpenClaw 网关（模型走自建 Kimi provider）
Documentation=https://docs.openclaw.ai
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${SERVICE_USER}
Group=${SERVICE_USER}
WorkingDirectory=${DATA_DIR}/workspace
Environment=HOME=${DATA_DIR}
Environment=XDG_CONFIG_HOME=${DATA_DIR}/.config
Environment=XDG_DATA_HOME=${DATA_DIR}/.local/share
Environment=XDG_STATE_HOME=${DATA_DIR}/.local/state
Environment=PATH=${NODE_BIN_DIR}:/usr/local/bin:/usr/bin:/bin
ExecStart=${OC_BIN} gateway --port ${PORT}
Restart=always
RestartSec=5

# 隔离：这台机器上还有 dazi 的生产站，agent 不该看得见它。
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ProtectKernelTunables=true
ProtectControlGroups=true
RestrictSUIDSGID=true
ReadWritePaths=${DATA_DIR}
InaccessiblePaths=-/var/lib/dazi -/etc/dazi.env

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now ${APP_NAME}
sleep 3
systemctl restart ${APP_NAME}
sleep 3

if ! systemctl is-active --quiet ${APP_NAME}; then
  warn "openclaw 没起来，最近的日志："
  journalctl -u ${APP_NAME} -n 40 --no-pager >&2 || true
  die "服务启动失败。常见原因：Node 版本不够、配置键名对不上这个 openclaw 版本。
     排查：journalctl -u openclaw -f"
fi

# 网关必须只在 127.0.0.1 上；万一哪天版本默认变成 0.0.0.0，这里要能立刻发现。
if (ss -ltn 2>/dev/null || netstat -ltn 2>/dev/null) | grep -q "0.0.0.0:${PORT} \|:::${PORT} "; then
  warn "网关监听在了所有网卡上（:${PORT}）。这是个能执行命令的 agent，别暴露到公网！"
  warn "请检查 openclaw 的 gateway 绑定设置，或用防火墙挡住这个端口。"
fi

# ---------------------------------------------------------------- 收尾

SERVER_IP="$(curl -fsS --max-time 6 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')"

cat >&2 <<INFO

$(printf '\033[1;32m装好了。\033[0m')

  模型      : kimi/${MODEL_ID}  →  ${BASE_URL}
  工具策略  : ${TOOL_PROFILE}
  网关      : 127.0.0.1:${PORT}（只监听本地，没有开公网端口）
  配置      : ${CONFIG_FILE}
  凭据      : ${ENV_FILE}
  工作区    : ${DATA_DIR}/workspace

$(printf '\033[1m从你自己的电脑访问 Web 面板\033[0m')

  ssh -N -L ${PORT}:127.0.0.1:${PORT} <你的用户名>@${SERVER_IP}
  然后浏览器打开 http://127.0.0.1:${PORT}

INFO

if [[ -n "$TG_TOKEN" && -z "$TG_ALLOW" ]]; then
  cat >&2 <<INFO
$(printf '\033[1mTelegram 首次配对\033[0m')

  1. 在 Telegram 里找到 @${tg_name:-你的bot} 发一句话
  2. 在服务器上：
       sudo -u ${SERVICE_USER} env HOME=${DATA_DIR} XDG_CONFIG_HOME=${DATA_DIR}/.config \\
         ${OC_BIN} pairing list telegram
       sudo -u ${SERVICE_USER} env HOME=${DATA_DIR} XDG_CONFIG_HOME=${DATA_DIR}/.config \\
         ${OC_BIN} pairing approve telegram <上一步显示的 CODE>
     配对码一小时内有效。
  3. 想彻底免配对，把你的 Telegram 数字 ID 填进来重跑：
       sudo OPENCLAW_TG_ALLOW=<你的数字ID> bash deploy/openclaw.sh

INFO
fi

cat >&2 <<INFO
$(printf '\033[1m日常运维\033[0m')

  systemctl status openclaw          # 状态
  journalctl -u openclaw -f          # 实时日志
  systemctl restart openclaw         # 重启
  sudo bash deploy/openclaw.sh       # 不带参数重跑 = 升级 + 重启，设置全沿用

$(printf '\033[1m换模型 / 换端点\033[0m')

  sudo OPENCLAW_MODEL=kimi-k2.7-code-highspeed bash deploy/openclaw.sh
  sudo OPENCLAW_BASE_URL=https://api.moonshot.ai/anthropic bash deploy/openclaw.sh

$(printf '\033[1m这个 agent 能碰到什么\033[0m')

  能：以 ${SERVICE_USER} 账号执行命令，读写 ${DATA_DIR}
  不能：读 /home 下任何人的家目录、读写 /var/lib/dazi、改系统目录、提权
  想再紧一点：sudo OPENCLAW_TOOLS=minimal bash deploy/openclaw.sh
  不想要了：sudo systemctl disable --now openclaw && sudo rm -rf ${APP_DIR} ${DATA_DIR} ${ENV_FILE}

INFO
