# 配置说明 · 填写指南与 Key 获取

贾维斯把所有模型密钥集中在 `config.json` 中管理，该文件**不会提交到仓库**（已加入 `.gitignore`）。你可以在网页的「SETTINGS」面板里直接填写，也可以手动编辑 `config.json`。

> 最小可用配置：**只填一个 DeepSeek API Key 就能对话**——TTS 默认走离线的 `pyttsx3`，无需任何 Key。

---

## 一、进入界面后要填什么

启动后浏览器打开 `http://127.0.0.1:5001`，点击左下角 dock 的 **⚙ SETTINGS** 展开设置面板，面板分三组：

### 1. LLM · 对话模型

选择你要用的对话模型提供方，**填对应那家的 Key 即可**（不用的那家留空）。

| 字段 | 填什么 | 是否必填 |
|------|--------|---------|
| Provider | `DeepSeek` 或 `火山方舟`，决定用哪家对话模型 | 是 |
| DeepSeek API Key | DeepSeek 的 `sk-` 开头 Key | 选 DeepSeek 时必填 |
| DeepSeek Base URL | 默认 `https://api.deepseek.com/v1`，不用改 | 否 |
| DeepSeek Model | 默认 `deepseek-chat`，可用 `deepseek-reasoner` | 否 |
| 火山方舟 API Key | 方舟的 API Key | 选方舟时必填 |
| 火山方舟 Base URL | 默认 `https://ark.cn-beijing.volces.com/api/v3`，不用改 | 否 |
| 火山方舟 Model | 模型名或接入点 ID（见下文） | 选方舟时必填 |

### 2. TTS · 语音合成

| 字段 | 填什么 | 是否必填 |
|------|--------|---------|
| 默认引擎 | `pyttsx3`（离线，开箱即用）/ `edge`（微软）/ `doubao`（火山） | 是 |
| 火山 App ID | 火山语音技术的 App ID | 仅用豆包时必填 |
| 火山 Access Key | 火山语音技术的 **Access Token**（见下文，不是方舟的 Key） | 仅用豆包时必填 |
| Speaker | 音色 ID，默认 `zh_male_m191_uranus_bigtts` | 否 |

> 只想先跑起来：保持 `pyttsx3`，这一组**全部留空**即可。

### 3. 网络 · 代理

| 字段 | 说明 |
|------|------|
| 连接方式 | `直连`（默认，DeepSeek / 火山均为国内服务，无需 VPN）/ `走系统代理`（接 OpenAI、Claude 等国外模型时才需要） |

填完点「保存配置」，状态提示「✓ 已保存并生效」，**无需重启**。密钥框留空 = 不修改原值。

---

## 二、如何获取各平台 Key

### 1. DeepSeek API Key

1. 打开 <https://platform.deepseek.com/>，注册并登录。
2. 进入左侧 **「API keys」**，点 **「创建 API key」**，复制 `sk-` 开头的 Key。
3. 在 **「充值 / Billing」** 页面先充一点余额（按量计费，价格很低；余额为 0 时调用会失败）。

> 文档：<https://api-docs.deepseek.com/>。Base URL 填 `https://api.deepseek.com/v1`，Model 填 `deepseek-chat`。

### 2. 火山方舟（Volc Ark）API Key

1. 打开 <https://console.volcengine.com/ark>，用火山引擎账号登录（需实名认证）。
2. 首次进入会提示开通「火山方舟」服务，同意协议并开通。
3. 进入左侧 **「API Key 管理」**，点 **「创建 API Key」**，复制 Key（**仅显示一次**，务必保存）。

**Model 字段填什么**（三选一）：

- 模型名：如 `deepseek-v3-241226`、`doubao-pro-32k`（在「模型广场」查看可用模型）；
- 或「推理接入点 ID」：在 **「在线推理」→「创建推理接入点」** 里选好模型后，得到一个 `ep-` 开头的接入点 ID，填入即可。

> 文档：<https://www.volcengine.com/docs/82379>。Base URL 填 `https://ark.cn-beijing.volces.com/api/v3`。

### 3. 火山语音 · 豆包 TTS（App ID + Access Token）

⚠️ 这里和方舟是**两套独立凭证**，别填错：方舟的 Key 给「对话模型」用，语音的 App ID / Access Token 给「TTS」用。

1. 打开 <https://console.volcengine.com/speech>，开通 **「语音技术」** 服务。
2. **App ID**：控制台 **「应用列表」→「创建应用」**，得到 AppID。
3. **Access Token**：控制台 **「密钥管理」** 里获取 Access Token（火山语音用 `AppID + Access Token` 鉴权，**不是**账号的 AK/SK）。
4. 把 App ID 填入 `火山 App ID`，Access Token 填入 `火山 Access Key`。
5. **Speaker** 可保持默认 `zh_male_m191_uranus_bigtts`，或在音色列表里选其他音色。

> 文档：<https://www.volcengine.com/docs/6561>。`resource_id` 默认 `seed-tts-2.0`，一般不用改。

---

## 三、字段速查表（config.json）

| 路径 | 含义 | 默认值 |
|------|------|--------|
| `llm.provider` | 对话模型提供方：`deepseek` / `volcark` | `deepseek` |
| `llm.deepseek.api_key` | DeepSeek API Key（敏感） | 空 |
| `llm.deepseek.base_url` | DeepSeek 接口地址 | `https://api.deepseek.com/v1` |
| `llm.deepseek.model` | DeepSeek 模型名 | `deepseek-chat` |
| `llm.volcark.api_key` | 火山方舟 API Key（敏感） | 空 |
| `llm.volcark.base_url` | 方舟 OpenAI 兼容地址 | `https://ark.cn-beijing.volces.com/api/v3` |
| `llm.volcark.model` | 方舟模型名或接入点 ID | 空 |
| `tts.engine` | TTS 引擎：`pyttsx3` / `edge` / `doubao` | `pyttsx3` |
| `tts.volc.app_id` | 火山语音 App ID | 空 |
| `tts.volc.access_key` | 火山语音 Access Token（敏感） | 空 |
| `tts.volc.speaker` | 豆包 TTS 音色 | `zh_male_m191_uranus_bigtts` |
| `tts.volc.resource_id` | TTS 资源 ID | `seed-tts-2.0` |
| `network.use_proxy` | 是否走系统代理（VPN） | `false`（直连） |

## 四、环境变量（可选覆盖）

优先级：**环境变量 > config.json**。可用环境变量覆盖，适合 Docker / 生产部署：

```bash
export DEEPSEEK_API_KEY="..."
export DEEPSEEK_BASE_URL="https://api.deepseek.com/v1"
export DEEPSEEK_MODEL="deepseek-chat"
export VOLC_APP_ID="..."
export VOLC_ACCESS_KEY="..."
```

## 五、安全提示

- 敏感字段（`api_key`、`access_key`）在 `GET /api/config` 时被脱敏，只返回 `{configured, value: "***尾4位"}`。
- `config.json` 已在 `.gitignore` 中，**不要**把含真实 Key 的文件提交进仓库。
- 若某 Key 曾泄露或误提交，请立即到对应平台**轮换**（重新生成）。
