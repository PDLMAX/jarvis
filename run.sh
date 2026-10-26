#!/usr/bin/env bash
# ── J.A.R.V.I.S. 一键启动脚本 (macOS / Linux) ──────────────────────────────
set -e
cd "$(dirname "$0")"

if [ ! -d .venv ]; then
  echo "📦 首次运行：创建 Python 虚拟环境..."
  python3 -m venv .venv
fi

source .venv/bin/activate

# 引导 pip 进 venv（uv 创建的 venv 默认不带 pip）
python3 -m ensurepip --upgrade --default-pip 2>/dev/null || true
python3 -m pip install -U pip -q

echo "⬇️  检查依赖..."
python3 -m pip install -r requirements.txt -q

# ── 豆包 TTS（Volcano Engine）API Key ────────────────────────────
# 密钥已迁移到 config.json（见 CONFIG.md）。
# 如需用环境变量覆盖，可在此 export（环境变量优先于 config.json）。

# ── 网络代理（VPN）──────────────────────────────────────────────
# 默认直连国内服务（DeepSeek / 火山方舟），无需 VPN。
# 如需走系统代理（接 OpenAI/Claude 等国外模型），在设置面板
# 打开「网络·代理 → 走系统代理」即可，无需改这里。
# 注意：不要在此 unset http_proxy 等变量，否则上面的开关会失效。

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  ⚡ J.A.R.V.I.S. 已上线"
echo "  🌐 浏览器打开  http://127.0.0.1:5001"
echo "  ⏹  Ctrl+C 关闭"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

python3 app.py
