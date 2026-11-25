#!/usr/bin/env bash
# ============================================================
# 在 WSL2 (Ubuntu) 里安装/修复官方 Hermes Agent + 配 DeepSeek + 常驻桥接
#
# 运行（在 WSL Ubuntu 终端，或由 Agent 通过 wsl.exe 调用）：
#   bash /mnt/d/WorkBuddy/projects/GlobalMarketMonitor/hermes-bridge/setup-wsl2.sh
#
# 本脚本是 2026-11-21 实战验证后的可靠版本，修复了三个坑：
#   1) key 必须从 Windows config.json 同步到 .env 和 config.yaml 两处
#      （旧版只读一次且读到过期 key → 401 认证失败）
#   2) 官方安装脚本首次运行有交互向导会卡死 → 用 --yes/跳过，已装则直接复用
#   3) 桥接用 nohup 启动会随 wsl 会话回收 → 改用 systemd user service 常驻
# 幂等：可重复运行。
# ============================================================
set -euo pipefail

PORT="${PORT:-8765}"
BRIDGE_DIR="/mnt/d/WorkBuddy/projects/GlobalMarketMonitor/hermes-bridge"
WIN_CONFIG="/mnt/d/WorkBuddy/projects/GlobalMarketMonitor/data/config.json"
HERMES_DIR="$HOME/.hermes"
HERMES_BIN="/home/freddy19871122/.hermes/hermes-agent/.hermes/bin/hermes"

line() { echo "────────────────────────────────────────"; }
echo "=== Hermes Agent 安装/修复向导（WSL2 Ubuntu）==="
line

# ---- 0. 从 Windows config.json 读当前有效 key（唯一可信来源）----
echo "[0/4] 读取 DeepSeek API Key（Windows config.json）..."
DEEPSEEK_KEY=""
if [ -f "$WIN_CONFIG" ]; then
  DEEPSEEK_KEY="$(python3 - "$WIN_CONFIG" <<'PY' 2>/dev/null || true
import json,sys
try:
    d=json.load(open(sys.argv[1],encoding='utf-8'))
    print(d.get('agent',{}).get('apiKey',''))
except Exception:
    pass
PY
)"
fi
[ -n "$DEEPSEEK_KEY" ] || { echo "✗ 未能从 config.json 读到 key，退出"; exit 1; }
echo "  ✓ key 已读取（${#DEEPSEEK_KEY} 字符，尾部 ...${DEEPSEEK_KEY: -6}）"

# ---- 1. 安装 / 复用 Hermes ----
line
echo "[1/4] 检查 Hermes Agent..."
if [ -x "$HERMES_BIN" ]; then
  echo "  ✓ hermes 已存在：$HERMES_BIN"
else
  echo "  未安装，执行官方安装脚本（可能耗时数分钟）..."
  curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash
  export PATH="$HOME/.local/bin:$PATH"
fi
[ -x "$HERMES_BIN" ] || { echo "✗ hermes 不可用，退出"; exit 1; }
"$HERMES_BIN" --version 2>/dev/null | head -1 || true

# ---- 2. 同步 DeepSeek 配置（.env + config.yaml 两处，标准模型名）----
line
echo "[2/4] 同步 DeepSeek 配置（key + 模型）..."
mkdir -p "$HERMES_DIR"
python3 - "$HERMES_DIR" "$DEEPSEEK_KEY" <<'PY'
import sys, os, re
home, key = sys.argv[1], sys.argv[2]

# .env：DEEPSEEK_API_KEY 必须是当前有效 key
p = os.path.join(home, '.env')
t = open(p, encoding='utf-8').read() if os.path.exists(p) else ''
if re.search(r'^DEEPSEEK_API_KEY=.*$', t, re.M):
    t = re.sub(r'^DEEPSEEK_API_KEY=.*$', 'DEEPSEEK_API_KEY=' + key, t, flags=re.M)
else:
    t += '\nDEEPSEEK_API_KEY=' + key + '\n'
# 确保 api_server 平台开启（原生 HTTP 端点，供将来直连）
for k, v in [('API_SERVER_ENABLED','true'),('API_SERVER_HOST','127.0.0.1'),('API_SERVER_PORT','8642')]:
    if re.search(r'^%s=.*$' % k, t, re.M):
        t = re.sub(r'^%s=.*$' % k, k+'='+v, t, flags=re.M)
    else:
        t += '%s=%s\n' % (k, v)
open(p,'w',encoding='utf-8').write(t); os.chmod(p,0o600)
print('  ✓ .env 已同步 key(尾%s) + api_server' % key[-6:])

# config.yaml：provider key + 标准模型名 deepseek-chat
p = os.path.join(home, 'config.yaml')
t = open(p, encoding='utf-8').read() if os.path.exists(p) else ''
if 'providers:' in t and re.search(r'(api_key: )sk-', t):
    t = re.sub(r'(api_key: )sk-[A-Za-z0-9]+', r'\1'+key, t, count=1)
else:
    t += '\nproviders:\n  deepseek:\n    api_key: %s\n    base_url: https://api.deepseek.com/v1\n    default_model: deepseek-chat\n' % key
t = re.sub(r'(default_model: )\S+', r'\1deepseek-chat', t, count=1)
if re.search(r'^  default: \S+', t, re.M):
    t = re.sub(r'^  default: \S+', '  default: deepseek-chat', t, count=1, flags=re.M)
if re.search(r'^  provider: \S+', t, re.M):
    t = re.sub(r'^  provider: \S+', '  provider: deepseek', t, count=1, flags=re.M)
open(p,'w',encoding='utf-8').write(t)
print('  ✓ config.yaml 已同步 provider key + model=deepseek-chat')
PY

# ---- 3. 重启 gateway 加载新配置 + 非交互自检 ----
line
echo "[3/4] 重启 gateway + 验证 Hermes→DeepSeek..."
"$HERMES_BIN" gateway restart 2>&1 | tail -3 || true
sleep 5
echo '请只回复：在线' | "$HERMES_BIN" chat --query-file - --oneshot -Q --no-restore-cwd 2>&1 | head -10 || {
  echo "  ! 自检未通过（对话会自动降级到 Node 直连 DeepSeek，不影响主服务）"
}

# ---- 4. systemd 常驻桥接（8765，供 Windows 访问）----
line
echo "[4/4] 配置 Hermes 桥接 systemd 常驻服务..."
mkdir -p "$HOME/.config/systemd/user"
cat > "$HOME/.config/systemd/user/hermes-bridge.service" <<EOF
[Unit]
Description=Hermes Bridge (OpenAI-compatible HTTP endpoint on $PORT)
After=network.target
[Service]
Type=simple
WorkingDirectory=$BRIDGE_DIR
Environment=HERMES_BIN=$HERMES_BIN
Environment=HERMES_TIMEOUT=120
ExecStart=/usr/bin/python3 $BRIDGE_DIR/hermes_bridge.py --host 0.0.0.0 --port $PORT
Restart=always
RestartSec=3
StandardOutput=append:$BRIDGE_DIR/bridge-systemd.log
StandardError=append:$BRIDGE_DIR/bridge-systemd.log
[Install]
WantedBy=default.target
EOF
systemctl --user daemon-reload
systemctl --user enable hermes-bridge.service 2>&1 | tail -1
systemctl --user restart hermes-bridge.service 2>&1 | tail -1
sleep 4
echo "  状态: $(systemctl --user is-active hermes-bridge.service)"
echo "  health: $(curl -s --max-time 5 http://127.0.0.1:$PORT/health)"
WSL_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
echo "  WSL IP: $WSL_IP（若 Windows 访问 127.0.0.1:$PORT 不通，用它）"
line
echo "完成。刷新 http://127.0.0.1:8777/ 左侧状态应变绿点 + Hermes 核心。"
echo "日志：tail -f $BRIDGE_DIR/bridge-systemd.log"
