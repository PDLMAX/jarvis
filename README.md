# J.A.R.V.I.S. · 你的个人 AI 语音助手

<div align="center">

一个运行在 **macOS 原生 App** 里的钢铁侠风格 AI 助手 —— 长按说话，贾维斯用豆包（火山引擎）的声音回答你。

**国内直连 · 免 VPN · 语音识别 + 大模型对话 + 语音合成 全链路**

</div>

---

## ✨ 功能特性

| 能力 | 说明 |
|------|------|
| 🎙️ **语音识别（ASR）** | 长按空格键说话，流式转写、边说边出字，基于火山引擎大模型 ASR |
| 🧠 **大模型对话** | 支持 DeepSeek / 火山方舟，可随时切换 |
| 🔊 **语音合成（TTS）** | 豆包（火山引擎）磁性男声，离线 `pyttsx3` 兜底 |
| 🖥️ **钢铁侠战甲 UI** | 战甲图库、数字化闪烁 HUD、Ticker 信息流、相册、音乐播放 |
| 🔧 **可视化设置面板** | 网页内直接填 Key、切模型，无需改文件、无需重启 |

> 语音识别走**原生 Swift 采集麦克风 → 本地 Flask 后端 → 火山引擎 ASR**，绕开了 WKWebView 不支持 Web Speech API 的限制，也绕开了本机某些音频驱动对麦克风的干扰。

---

## 🚀 快速开始

**前置条件**：macOS 11.0+，已安装 Xcode Command Line Tools（含 `swiftc`）和 Python 3.9+。

```bash
# 1. 克隆仓库
git clone https://github.com/<你的用户名>/jarvis.git
cd jarvis

# 2. 配置密钥（把 config.example.json 复制为 config.json 并填入 Key）
cp config.example.json config.json
#   用编辑器打开 config.json，填入你的 DeepSeek API Key（最小可用）

# 3. 启动后端
./run.sh
#   浏览器打开 http://127.0.0.1:5001 即可网页使用

# 4.（可选）编译原生 macOS App，获得"长按说话"语音体验
cd desktop && bash build.sh && open JARVIS.app
```

> **最小可用配置**：只填一个 DeepSeek API Key 就能对话，TTS 默认走离线 `pyttsx3`。
> 语音识别需要火山引擎 App ID + Access Token（与豆包 TTS 同一套密钥）。

完整的环境搭建、密钥申请、编译部署流程，见 **[📖 DEPLOY.md](DEPLOY.md)**。

---

## 🗂️ 项目结构

```
jarvis/
├── app.py                  # Flask + SocketIO 后端（对话 / ASR / TTS / 相册 / 音乐）
├── asr_volc.py             # 火山引擎大模型流式 ASR 客户端
├── config.py               # 配置管理（config.json 读写、脱敏、环境变量覆盖）
├── config.example.json     # 配置模板（复制为 config.json 使用）
├── CONFIG.md               # 配置字段与 Key 获取详细说明
├── requirements.txt        # Python 依赖
├── run.sh / run.bat        # 一键启动脚本（macOS / Windows）
├── desktop/                # macOS 原生 App（Swift）
│   ├── Sources/main.swift            # App 主逻辑 + 空格键监听 + WebView 壳
│   ├── Sources/SpeechController.swift # 录音 + HTTP 推流到后端 ASR
│   ├── build.sh                      # 编译打包脚本
│   ├── Info.plist                    # 权限声明（麦克风 / 语音识别）
│   └── AppIcon.icns                  # 应用图标
├── static/                 # 前端 JS / CSS
├── templates/              # HTML 模板
└── tests/                  # 单元测试
```

---

## 🔑 密钥说明

所有密钥集中在 `config.json`（**已加入 `.gitignore`，不会提交到仓库**），支持环境变量覆盖：

| 服务 | 需要什么 | 用途 | 是否必填 |
|------|---------|------|---------|
| DeepSeek | API Key（`sk-`） | 对话模型 | 至少填一家 |
| 火山方舟 | API Key | 对话模型（可选替代） | 否 |
| 火山语音 | App ID + Access Token | 豆包 TTS + 语音识别 | 语音功能需要 |

获取方式详见 **[CONFIG.md](CONFIG.md)**。

> ⚠️ **安全提示**：切勿把真实 Key 提交进 Git。若曾误提交，请立即到对应平台轮换（重新生成）密钥。

---

## 🛠️ 技术栈

- **后端**：Python · Flask · Flask-SocketIO · Eventlet
- **前端**：原生 HTML/CSS/JS（WKWebView 壳加载）
- **桌面**：Swift（AVFoundation 录音 + WebKit）
- **AI 服务**：DeepSeek / 火山方舟（LLM）· 火山引擎（ASR + TTS）

---

## 📄 许可证

[MIT License](LICENSE)

## 🙏 免责声明

本项目仅供学习交流使用。仓库**不包含**任何音乐、照片等媒体文件（已通过 `.gitignore` 排除），也不包含任何真实密钥。使用第三方 AI 服务产生的费用由使用者自行承担。
