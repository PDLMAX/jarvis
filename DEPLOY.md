# 📖 macOS 部署教程 · J.A.R.V.I.S. 从零到运行

本手册手把手教你在 **macOS** 上把 J.A.R.V.I.S. 跑起来，获得完整的「长按说话 → 语音识别 → 大模型回答 → 豆包语音播报」体验。

**预计耗时**：首次约 20~30 分钟（含申请密钥）。

---

## 目录

1. [前置准备](#1-前置准备)
2. [克隆代码与安装依赖](#2-克隆代码与安装依赖)
3. [申请 API 密钥](#3-申请-api-密钥)
4. [配置密钥](#4-配置密钥)
5. [启动后端（网页版）](#5-启动后端网页版)
6. [编译原生 App（语音版）](#6-编译原生-app语音版)
7. [常见问题排查](#7-常见问题排查)

---

## 1. 前置准备

### 1.1 检查系统版本

- macOS **11.0（Big Sur）** 及以上。
- 点击左上角  →「关于本机」查看版本。

### 1.2 安装 Xcode Command Line Tools

编译原生 App 需要 `swiftc`（Swift 编译器），Python 也需要系统提供的工具链。

```bash
xcode-select --install
```

安装完成后验证：

```bash
swiftc --version
# 应输出类似：Swift version 5.x ...
```

> 如果提示已安装但 `swiftc` 找不到，运行 `sudo xcode-select --reset` 后重试。

### 1.3 确认 Python 3.9+

macOS 自带的 `python3` 通常够用：

```bash
python3 --version
# 应输出 3.9 或更高
```

> 若版本过低，推荐用 Homebrew 安装：`brew install python@3.11`。

---

## 2. 克隆代码与安装依赖

```bash
# 克隆仓库
git clone https://github.com/<你的用户名>/jarvis.git
cd jarvis

# 创建并激活虚拟环境
python3 -m venv .venv
source .venv/bin/activate

# 安装依赖
python3 -m pip install -r requirements.txt
```

> 也可以直接运行 `./run.sh`，脚本会自动完成「建环境 → 装依赖 → 启动」全流程。

---

## 3. 申请 API 密钥

你需要决定用哪些功能，对应申请密钥：

| 功能 | 服务 | 需要 | 是否必填 |
|------|------|------|---------|
| 对话 | DeepSeek | API Key | ✅ 必填（或改用火山方舟） |
| 语音合成 | 火山语音（豆包） | App ID + Access Token | 可选（不填则用离线 `pyttsx3`） |
| 语音识别 | 火山语音（豆包） | App ID + Access Token | 可选（**与 TTS 是同一套密钥**） |

> 💡 **想先跑起来**：只申请 DeepSeek 的 Key 即可对话（文字回复，无语音）。之后随时补火山密钥升级语音。

### 3.1 DeepSeek API Key

1. 打开 <https://platform.deepseek.com/>，注册并登录。
2. 左侧 **「API keys」** → **「创建 API key」** → 复制 `sk-` 开头的 Key（**只显示一次**）。
3. 在 **「充值 / Billing」** 页先充一点余额（按量计费，余额为 0 时调用会失败）。

> Base URL 用默认 `https://api.deepseek.com/v1`，模型用 `deepseek-chat`。

### 3.2 火山引擎 · 语音（豆包 TTS + ASR 共用）

⚠️ **重点**：火山语音和「火山方舟」是**两套独立凭证**，别混用。

1. 打开 <https://console.volcengine.com/speech>，注册登录（需实名认证）。
2. 开通 **「语音技术」** 服务。
3. **App ID**：控制台 **「应用列表」→「创建应用」**，得到 AppID。
4. **Access Token**：控制台 **「密钥管理」** 里获取 Access Token（火山语音用 `AppID + Access Token` 鉴权，**不是**账号的 AK/SK）。

把这两个值填进 `config.json` 的 `tts.volc.app_id` 和 `tts.volc.access_key` 即可，**同时解锁豆包 TTS 和语音识别**。

> 文档：<https://www.volcengine.com/docs/6561>

### 3.3（可选）火山方舟 API Key

如需用火山方舟作为对话模型（替代 DeepSeek）：

1. 打开 <https://console.volcengine.com/ark>，开通「火山方舟」。
2. 左侧 **「API Key 管理」→「创建 API Key」**，复制 Key。
3. Model 字段填模型名（如 `doubao-pro-32k`）或推理接入点 ID（`ep-` 开头）。

---

## 4. 配置密钥

```bash
# 用模板生成配置文件
cp config.example.json config.json
```

用任意编辑器打开 `config.json`，填入你的密钥。**最小配置**（只对话）如下：

```json
{
  "llm": {
    "provider": "deepseek",
    "deepseek": {
      "api_key": "sk-你的DeepSeekKey",
      "base_url": "https://api.deepseek.com/v1",
      "model": "deepseek-chat"
    }
  },
  "tts": {
    "engine": "doubao",
    "volc": {
      "app_id": "你的AppID",
      "access_key": "你的AccessToken",
      "resource_id": "seed-tts-2.0",
      "speaker": "zh_male_m191_uranus_bigtts",
      "endpoint": "https://openspeech.bytedance.com/api/v3/tts/unidirectional/sse"
    }
  },
  "network": {
    "use_proxy": false
  }
}
```

> ⚠️ `config.json` 已在 `.gitignore` 中，**不会**被提交到仓库。请勿把它改名或强制提交。
>
> 完整字段说明见 **[CONFIG.md](CONFIG.md)**。

---

## 5. 启动后端（网页版）

```bash
./run.sh
```

看到如下输出即成功：

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  ⚡ J.A.R.V.I.S. 已上线
  🌐 浏览器打开  http://127.0.0.1:5001
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

浏览器打开 <http://127.0.0.1:5001>，即可文字对话。

---

## 6. 编译原生 App（语音版）

网页版**不支持语音**（WKWebView 不含 Web Speech API）。要获得「长按空格说话」的体验，需编译原生 App。

### 6.1 编译

```bash
cd desktop
bash build.sh
```

脚本会自动：生成图标 → 用 `swiftc` 编译 → 打包 `.app` → ad-hoc 签名。

成功后生成 `desktop/JARVIS.app`。

### 6.2 启动与授权

```bash
open JARVIS.app
```

- 首次启动会弹出 **麦克风权限** 请求，点「好」。
- 首次长按**空格键**说话时，系统可能再次请求权限，允许即可。

### 6.3 使用方式

| 操作 | 效果 |
|------|------|
| **按住空格键** | 开始录音（屏幕中间圆圈会亮起，边说边出字） |
| **松开空格键** | 结束录音 → 识别 → 大模型回答 → 豆包语音播报 |

> 提示：说**稍长一点的句子**（3 秒以上）识别准确率最高。极短的 1 秒片段，多语种 ASR 可能误判语种。

---

## 7. 常见问题排查

### 7.1 语音没反应 / 识别为空

1. 检查麦克风权限：系统设置 → 隐私与安全性 → 麦克风 → 确认 JARVIS 已勾选。
2. 查看诊断日志：

```bash
tail -f /tmp/jarvis_speech.log     # Swift 录音 + ASR 诊断
tail -f /tmp/jarvis_backend.log    # 后端日志
```

- 若看到 `最大输入电平 = -120.0 dB`，说明麦克风没采到声音，检查输入设备。
- 若看到 `Timeout waiting next packet`，可能是网络或密钥问题。

### 7.2 火山 ASR 返回 400 / 403

- `403 not granted`：Access Token 无权限，检查是否开通了「语音技术」的大模型 ASR 资源。
- `400 not allowed`：`resource_id` 不对，ASR 需用 `volc.bigasr.sauc.duration`（代码已内置，一般无需改）。

### 7.3 依赖安装失败

- `pygame` 在 macOS 上若报错，可先 `brew install sdl2 sdl2_mixer` 再装。
- `pyttsx3` 离线 TTS 需要系统自带语音，默认可用。

### 7.4 改了前端代码不生效

后端 `debug=False` 时会缓存模板，改完 `templates/index.html` 需**重启后端**：

```bash
pkill -f "python3 app.py"
./run.sh
```

### 7.5 想走代理（VPN）

默认直连国内服务（DeepSeek / 火山），无需 VPN。如需接 OpenAI/Claude 等国外模型，在设置面板打开「网络 · 代理 → 走系统代理」，或改 `config.json` 的 `network.use_proxy = true`。

---

## 📚 更多

- 字段与 Key 获取详解：[CONFIG.md](CONFIG.md)
- 项目总览：[README.md](README.md)
