#!/usr/bin/env bash
# ── 构建 JARVIS 原生 macOS App ──────────────────────────────────
set -e
cd "$(dirname "$0")"

APP="JARVIS.app"
BIN="$APP/Contents/MacOS/JARVIS"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

# 1) 生成图标（若不存在）
if [ ! -f AppIcon.icns ]; then
  echo "🎨 生成 JARVIS 图标…"
  swift Sources/make_icon.swift
fi

# 2) 编译原生 App
echo "🔨 编译原生 App…"
swiftc -O \
  Sources/main.swift \
  Sources/SpeechController.swift \
  -o "$BIN"

# 3) 打包
cp Info.plist "$APP/Contents/Info.plist"
cp AppIcon.icns "$APP/Contents/Resources/AppIcon.icns"

# 4) 临时签名：稳定 TCC 麦克风/语音识别权限（避免每次重建后权限重置）
codesign --force --deep --sign - "$APP" 2>/dev/null || echo "⚠ 签名失败（不影响运行，但权限可能不稳定）"

echo ""
echo "✅ 已生成 $APP"
echo "   双击启动（首次会请求麦克风 / 语音识别权限）"
