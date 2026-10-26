# -*- coding: utf-8 -*-
"""
  J.A.R.V.I.S. · 后端主入口
  Flask + Flask-SocketIO；处理语音识别文本 → 执行命令 → TTS 回传。
  启动方式：python3 app.py
"""

import os
import re
import io
import sys
import ssl
import signal
import asyncio
import base64
import json
import logging
import tempfile
import subprocess
import webbrowser
import mimetypes
import time
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
from threading import Thread, Event, Lock
from datetime import datetime
from uuid import uuid4

import config
import asr_volc

from werkzeug.utils import secure_filename

# ── Web ──────────────────────────────────────────────────────────
from flask import Flask, render_template, request, send_file
from flask_socketio import SocketIO, emit

# ── LLM（DeepSeek，OpenAI 兼容接口）──────────────────────────────
import openai
import httpx
# 模型密钥从 config.json 加载（环境变量优先），由 _reload_globals() 初始化
_DSK_API_KEY = ""
_DSK_BASE_URL = ""
_DSK_MODEL = ""
# 是否走系统代理（VPN）：默认 False = 直连国内服务，忽略 http_proxy 环境变量
_USE_PROXY = False
_DSK_SYSTEM = (
    "你是 J.A.R.V.I.S.(贾维斯)——一位冷静、幽默、高效的 AI 私人助理。"
    "回答请简洁（80 字内）且优雅，像一个真正有性格的管家；"
    "避免啰嗦；遇到中文问题用中文回答，英文问题用英文回答。"
    "不要暴露自己是 AI 或 LLM，身份就是贾维斯。"
)

def ask_deepseek(user_text: str, user_engine: str, socket_id=None) -> str:
    """调 DeepSeek 聊生模型。失败则返回 None。

    注意：本函数已在 exec_pool 工作线程内运行（由 handle_transcript 调用），
    因此这里直接同步调用 OpenAI，绝不再向同一线程池 submit + 阻塞等待——
    否则两个工作线程会互相等对方释放，触发线程池嵌套死锁，
    表现为「对话几次后就没回复」。
    """
    if not _DSK_API_KEY:
        return None
    try:
        client = openai.OpenAI(api_key=_DSK_API_KEY, base_url=_DSK_BASE_URL,
                               timeout=25,
                               http_client=httpx.Client(trust_env=_USE_PROXY))
        resp = client.chat.completions.create(
            model=_DSK_MODEL,
            messages=[
                {"role": "system", "content": _DSK_SYSTEM},
                {"role": "user",   "content": user_text},
            ],
            max_tokens=200,
            temperature=0.8,
        )
        answer = resp.choices[0].message.content.strip()
        log_emit(f"[J·A·R·V·I·S] {answer}", cls="bot",
                 state="speaking", state_label="DEEPSEEK")
        return answer
    except Exception as e:
        log_emit(f"[错误] DeepSeek 调用失败：{e}", cls="error")
        return None

# ── 语音 / 系统 ──────────────────────────────────────────────────
try:   import pyttsx3; PYTTSX3_OK = True
except ImportError: PYTTSX3_OK = False

try:
    import edge_tts
    EDGE_OK = True
except ImportError:
    EDGE_OK = False

try:
    import pygame
    PYGAME_OK = True
except ImportError:
    PYGAME_OK = False

try:
    import psutil
    PSUTIL_OK = True
except ImportError:
    PSUTIL_OK = False

# ══════════════════════════════════════════════════════════════════
# 全局配置 / 状态
# ══════════════════════════════════════════════════════════════════
BASE_DIR  = Path(__file__).resolve().parent
MEDIA_DIR = BASE_DIR / "media"
HOME_MUSIC = Path.home() / "Music"

app = Flask(
    __name__,
    template_folder=str(BASE_DIR / "templates"),
    static_folder=str(BASE_DIR / "static"),
)
app.config["SECRET_KEY"] = "jarvis-secret-key"
socketio = SocketIO(app, cors_allowed_origins="*", async_mode="threading")

log = logging.getLogger("jarvis")
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)

# ── 会话状态 ─────────────────────────────────────────────────────
music_playlist: list = []       # 完整路径列表
music_idx: int      = 0
music_paused: bool  = False
music_proc: object  = None      # 外部播放器 subprocess.Popen 句柄
session_engine: list = ["pyttsx3"]   # 默认离线引擎，避免 edge 403 时卡死

TTS_DIR = Path(tempfile.mkdtemp(prefix="jarvis_tts_"))

# macOS 离线 TTS：直接用 `say` 命令（自带中文，零外部依赖）
OFFLINE_VOICE = "Eddy (中文（中国大陆）)"
OFFLINE_RATE  = "180"

# ── 火山引擎"豆包"TTS ─────────────────────────────────────────────
VOLC_APP_ID = ""
VOLC_ACCESS_KEY = ""
VOLC_RESOURCE_ID = "seed-tts-2.0"
VOLC_SPEAKER = "zh_male_m191_uranus_bigtts"
VOLC_TTS_ENDPOINT = "https://openspeech.bytedance.com/api/v3/tts/unidirectional/sse"


def _as_bool(value) -> bool:
    """把布尔或字符串 'true'/'1' 等归一化为 bool。"""
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in ("true", "1", "yes", "on")


def _reload_globals():
    """从 config 重新加载模型密钥到模块级全局变量（保存配置后热更新）。"""
    global _DSK_API_KEY, _DSK_BASE_URL, _DSK_MODEL, _USE_PROXY
    global VOLC_APP_ID, VOLC_ACCESS_KEY, VOLC_RESOURCE_ID, VOLC_SPEAKER, VOLC_TTS_ENDPOINT
    cfg = config.effective_config()
    _DSK_API_KEY = config.get_path(cfg, "llm.deepseek.api_key") or ""
    _DSK_BASE_URL = config.get_path(cfg, "llm.deepseek.base_url") or ""
    _DSK_MODEL = config.get_path(cfg, "llm.deepseek.model") or "deepseek-chat"
    _USE_PROXY = _as_bool(config.get_path(cfg, "network.use_proxy"))
    VOLC_APP_ID = config.get_path(cfg, "tts.volc.app_id") or ""
    VOLC_ACCESS_KEY = config.get_path(cfg, "tts.volc.access_key") or ""
    VOLC_RESOURCE_ID = config.get_path(cfg, "tts.volc.resource_id") or "seed-tts-2.0"
    VOLC_SPEAKER = config.get_path(cfg, "tts.volc.speaker") or "zh_male_m191_uranus_bigtts"
    VOLC_TTS_ENDPOINT = config.get_path(cfg, "tts.volc.endpoint") or "https://openspeech.bytedance.com/api/v3/tts/unidirectional/sse"


_reload_globals()

# ── 只允许的安全命令前缀（"终端执行" 沙箱） ──────────────────────
SAFE_CMD_PREFIXES = (
    "git ", "git\t", "ls", "pwd", "echo", "date", "whoami",
    "python3", "pip", "node", "npm", "pnpm", "yarn",
    "grep", "find", "head", "tail", "wc", "cat",
    "docker", "kubectl", "helm",
)

exec_pool = ThreadPoolExecutor(max_workers=6)

# ── Chat / Upload state ─────────────────────────────────────────
_chat_history: list = []
_chat_lock = Lock()
_upload_dir = BASE_DIR / "uploads"
_upload_dir.mkdir(exist_ok=True)
ALLOWED_EXTS = {
    ".txt", ".md", ".py", ".js", ".json", ".csv", ".log",
    ".html", ".css", ".xml", ".yaml", ".yml", ".toml", ".ini",
    ".sh", ".bat", ".rst", ".rtf",
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg",
    ".pdf", ".doc", ".docx",
}
MAX_UPLOAD_BYTES = 10 * 1024 * 1024  # 10 MB

# ── 持久化聊天历史 ─────────────────────────────────────────────
HISTORY_FILE = BASE_DIR / "chat_history.json"
HISTORY_MAX = 500
_history_lock = Lock()


def _load_history() -> list:
    """读取聊天历史文件；不存在或损坏时返回空列表。"""
    try:
        data = json.loads(HISTORY_FILE.read_text("utf-8"))
        if isinstance(data, list):
            return data
    except (OSError, ValueError):
        pass
    return []


def _save_history(msgs: list) -> None:
    """原子写入聊天历史（写临时文件后 os.replace）。"""
    tmp = HISTORY_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(msgs, ensure_ascii=False, indent=2), "utf-8")
    os.replace(tmp, HISTORY_FILE)


def _append_history(role: str, text: str) -> dict:
    """追加一条聊天记录并落盘，返回带 id/time 的记录。"""
    with _history_lock:
        msgs = _load_history()
        msg = {
            "id": uuid4().hex,
            "role": role,
            "text": text,
            "time": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        }
        msgs.append(msg)
        _save_history(msgs[-HISTORY_MAX:])
        return msg

# ══════════════════════════════════════════════════════════════════
# 工具函数
# ══════════════════════════════════════════════════════════════════
def log_emit(text, cls=None, state=None, state_label=None):
    """写后端日志 + 把一行文本推送到前端 UI"""
    payload = {"text": text, "cls": cls or "bot"}
    socketio.emit("console_log", payload)
    if state:
        socketio.emit(
            "status",
            {"state": state, "label": state_label or state.upper()},
        )
    log.info(text)


def speak(text: str, engine: str, sid=None):
    """TTS：把 text 合成为 Base64 WAV → 发到前端 <audio> 播放"""
    text = (text or "").strip()
    if not text:
        return
    log_emit(f"[TTS · {engine}] {text[:60]}…", state="speaking", state_label="SPEAKING")

    # ── 解析前端传来的 engine 标识，落到本地三档 TTS ──
    def _resolve_chain(preferred: str):
        """
        返回 [(label, callable), ...] 优先级列表。
        优先级：doubao(云) > edge(微软) > pyttsx3(本地 say)
        首选引擎放第一位，剩下的按性能排序。
        """
        engines = {
            "doubao": ("doubao", _tts_doubao)  if VOLC_APP_ID and VOLC_ACCESS_KEY else None,
            "edge":   ("edge",   _tts_edge)      if EDGE_OK     else None,
            "pyttsx3":("pyttsx3",_tts_pyttsx3),   # macOS 用 say，其他用 pyttsx3，始终可用
        }
        chain = []
        # 首选放第一
        if preferred in engines and engines[preferred]:
            chain.append(engines[preferred])
        # 其他按性能排序兜底
        for key in ["doubao", "edge", "pyttsx3"]:
            if key in engines and engines[key] and engines[key] not in chain:
                chain.append(engines[key])
        return chain

    def _generate():
        chain = _resolve_chain(engine)
        if not chain:
            log_emit("[错误] 无可用的 TTS 引擎", cls="error",
                     state="idle", state_label="STANDBY")
            return
        for label, fn in chain:
            try:
                b64 = fn(text)
                socketio.emit("tts_audio", {"audio": b64, "engine": label})
                return
            except Exception as e:
                log_emit(f"⚠ {label} TTS 失败：{e} → 尝试下一档", cls="error")
                continue
        log_emit("[错误] 所有 TTS 引擎都失败", cls="error",
                 state="idle", state_label="STANDBY")

    Thread(target=_generate, daemon=True).start()


def _tts_pyttsx3(text: str) -> str:
    """
    离线 TTS：macOS 用内置 `say`（原生中文，零外部依赖）；
    其他平台用 pyttsx3。
    输出 WAV。
    """
    out = TTS_DIR / f"tts_{abs(hash(text))}.wav"

    if sys.platform == "darwin":
        aiff = out.with_suffix(".aiff")
        subprocess.run(
            ["say", "-v", OFFLINE_VOICE, "-r", OFFLINE_RATE, "-o", str(aiff), text],
            check=True, timeout=30,
        )
        try:
            subprocess.run(
                ["afconvert", str(aiff), str(out), "-f", "WAVE", "-d", "LEI16@22050"],
                check=True, timeout=30,
            )
        except Exception:
            out = aiff
        b64 = base64.b64encode(out.read_bytes()).decode()
        for p in (out, aiff):
            try: p.unlink()
            except OSError: pass
        return b64

    if PYTTSX3_OK:
        out_w = TTS_DIR / f"tts_pyttsx3_{abs(hash(text))}.wav"
        engine = pyttsx3.init()
        engine.setProperty("rate", 155)
        engine.setProperty("volume", 0.9)
        engine.save_to_file(text, str(out_w))
        engine.runAndWait()
        b64 = base64.b64encode(out_w.read_bytes()).decode()
        try: out_w.unlink()
        except OSError: pass
        return b64
    raise RuntimeError("离线 TTS 不可用（非 macOS 且未安装 pyttsx3）")


def _tts_doubao(text: str) -> str:
    """火山引擎豆包 TTS —— HTTPS SSE 接口，返回 base64 MP3。

    实现：直接 shell-out 到 curl（urllib 在某些网络栈下会被火山引擎资源层拒绝）
    """
    if not VOLC_APP_ID or not VOLC_ACCESS_KEY:
        raise RuntimeError("VOLC_APP_ID / VOLC_ACCESS_KEY 未配置")

    import subprocess, json, tempfile, os

    payload = json.dumps({
        "user": {"uid": "jarvis"},
        "req_params": {
            "text": text,
            "speaker": VOLC_SPEAKER,
            "audio_params": {"format": "mp3", "sample_rate": 24000},
        },
    })

    cmd = [
        "curl", "-sS", "--noproxy", "*", "-N",
        "-X", "POST", VOLC_TTS_ENDPOINT,
        "-H", f"X-Api-App-Id: {VOLC_APP_ID}",
        "-H", f"X-Api-Access-Key: {VOLC_ACCESS_KEY}",
        "-H", f"X-Api-Resource-Id: {VOLC_RESOURCE_ID}",
        "-H", "Content-Type: application/json",
        "-d", payload,
        "--max-time", "25",
    ]

    r = subprocess.run(cmd, capture_output=True, text=True, timeout=30,
                       env={**os.environ, "http_proxy": "", "https_proxy": "",
                            "HTTP_PROXY": "", "HTTPS_PROXY": ""})
    if r.returncode != 0:
        raise RuntimeError(f"curl 调用失败: {r.stderr[:200]}")

    audio_chunks = []
    err_code = None
    err_msg = ""
    for line in r.stdout.splitlines():
        line = line.strip()
        if not line.startswith("data:"):
            continue
        try:
            chunk = json.loads(line[5:].strip())
        except json.JSONDecodeError:
            continue
        code = chunk.get("code")
        # 火山成功码：0 = 音频数据，20000000 = 最终状态；其他码为错误
        if code not in (None, 0, 20000000):
            err_code = code
            err_msg = chunk.get("message", "")
            continue
        if chunk.get("data"):
            audio_chunks.append(chunk["data"])

    if err_code is not None:
        raise RuntimeError(f"火山返回错误 code={err_code}: {err_msg}")
    if not audio_chunks:
        raise RuntimeError("豆包 TTS 返回音频为空")

    combined_b64 = "".join(audio_chunks)
    raw_audio = base64.b64decode(combined_b64)
    return base64.b64encode(raw_audio).decode()


def _tts_edge(text: str) -> str:
    out = TTS_DIR / f"edge_{abs(hash(text))}.mp3"
    async def _run():
        comm = edge_tts.Communicate(
            text, "zh-CN-XiaoxiaoNeural", rate="+8%", volume="+0%"
        )
        with open(str(out), "wb") as f:
            async for chunk in comm.stream():
                if chunk["type"] == "audio":
                    f.write(chunk["data"])
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    try: loop.run_until_complete(_run())
    finally: loop.close()
    # edge-tts 输出的是 mp3，浏览器 <audio> 也吃
    # 但后端外面标注 wav，这里直接让前端按 "audio/*" 播放
    b64 = base64.b64encode(out.read_bytes()).decode()
    try: out.unlink()
    except OSError: pass
    return b64


# ══════════════════════════════════════════════════════════════════
# 命令执行（沙箱）
# ══════════════════════════════════════════════════════════════════
def safe_run(cmd: str, timeout: int = 30) -> str:
    if not cmd:
        return ""
    # 拒绝危险关键字
    blocked = ["rm -rf", "sudo", "shutdown", "reboot", "mkfs", ":(){ :|:& };:"]
    for b in blocked:
        if b in cmd:
            return "⛔ 危险命令已拦截：" + cmd
    # 白名单校验
    if not any(cmd.strip().startswith(p) for p in SAFE_CMD_PREFIXES):
        raise ValueError(
            f"未授权命令：{cmd}\n（只允许：{'、'.join(s.strip() for s in SAFE_CMD_PREFIXES)} …）"
        )
    r = subprocess.run(
        cmd, shell=True, capture_output=True, text=True, timeout=timeout
    )
    return (r.stdout + ("\n" if r.stdout and r.stderr else "") + r.stderr).strip()


# ══════════════════════════════════════════════════════════════════
# 命令映射
# ══════════════════════════════════════════════════════════════════
def cmd_play_music():
    global music_playlist, music_idx, music_paused, music_proc
    exts = {".mp3", ".wav", ".flac", ".ogg", ".m4a"}
    files = []
    for d in (MEDIA_DIR, HOME_MUSIC):
        if d.exists():
            for f in d.iterdir():
                if f.suffix.lower() in exts:
                    files.append(str(f.resolve()))
    if not files:
        log_emit("⚠ 未在 media/ 或 ~/Music 找到音频文件", cls="error")
        speak("未找到任何音频文件，请在 media 目录放入音乐", engine="pyttsx3")
        return
    # 停止当前播放再切歌
    _stop_current()
    music_playlist = sorted(files)
    music_idx = 0
    music_paused = False
    _play_current()


def _stop_current():
    """ terminate 当前 pygame 或外部播放器 """
    global music_proc
    if PYGAME_OK and pygame.mixer.get_init():
        try:
            pygame.mixer.music.stop()
        except Exception:
            pass
    if music_proc and music_proc.poll() is None:
        try:
            music_proc.terminate()
            music_proc.wait(timeout=3)
        except Exception:
            pass
        music_proc = None


def _play_current():
    global music_paused, music_proc
    if not music_playlist:
        log_emit("⚠ 播放列表为空", cls="error")
        return
    # start with pygame if available
    track = music_playlist[music_idx]
    name = Path(track).name
    log_emit(f"🎵 正在播放：{name}  ({music_idx + 1}/{len(music_playlist)})", cls="bot")
    socketio.emit("music_event", {"text": f"PLAYING: {name}", "cls": "bot"})
    music_proc = None
    if PYGAME_OK:
        try:
            if not pygame.mixer.get_init():
                pygame.mixer.init()
            pygame.mixer.music.load(track)
            pygame.mixer.music.play()
            music_paused = False
            return
        except Exception as e:
            log_emit(f"[pygame] {e}，回退到系统播放器", cls="error")
    # fall back to system default player via subprocess (track handle)
    try:
        if sys.platform == "darwin":     # macOS
            music_proc = subprocess.Popen(["open", "-a", "QuickTime Player", track])
        elif sys.platform == "win32":
            music_proc = subprocess.Popen(["start", "", track], shell=True)
        else:
            music_proc = subprocess.Popen(["xdg-open", track])
    except Exception as e:
        log_emit(f"[错误] 系统播放器启动失败：{e}", cls="error")


def cmd_pause_music():
    """toggle pause / resume the current track"""
    global music_paused
    if PYGAME_OK and pygame.mixer.get_init():
        if music_paused:
            pygame.mixer.music.unpause()
            music_paused = False
            log_emit("▶ 已恢复")
            socketio.emit("music_event", {"text": "RESUME"})
        else:
            pygame.mixer.music.pause()
            music_paused = True
            log_emit("⏸ 已暂停")
            socketio.emit("music_event", {"text": "PAUSED"})
    else:
        log_emit("⚠ pygame 未初始化（无法暂停/继续）", cls="error")
        speak("音乐通过外部播放器启动，暂不支持暂停。建议改用 pygame 模式（pip install pygame）", engine=session_engine[0])


def cmd_stop_music():
    """stop playback entirely"""
    global music_paused
    _stop_current()
    music_paused = False
    log_emit("⏹ 已停止")
    socketio.emit("music_event", {"text": "STOPPED"})


def cmd_next_track():
    global music_idx
    if not music_playlist:
        return
    music_idx = (music_idx + 1) % len(music_playlist)
    _play_current()


def cmd_proj_status():
    for fname in ("README.md", "log.txt"):
        p = BASE_DIR / fname
        if p.exists():
            text = p.read_text("utf-8", errors="replace")[:500]
            log_emit(f"[{fname}.FIRST_500]\n{text}", cls="bot",
                     state="speaking", state_label="SPEAKING")
            speak(f"项目进度播报：{text}", engine=session_engine[0])
            return
    speak("未找到 README 或 log 文件", engine="pyttsx3")


def cmd_open_browser(url: str = "https://github.com"):
    try:
        webbrowser.open(url)
        log_emit(f"🌐 已在浏览器打开 {url}", state="speaking",
                 state_label="SPEAKING")
        speak("已为您打开浏览器", engine="edge")
    except Exception as e:
        log_emit(f"[错误] 无法打开浏览器：{e}", cls="error")


def cmd_terminal_exec(user_text: str, engine: str):
    m = re.search(r"(?:终端执行|执行命令|终端|运行|执行|run|exec)\s+(.+)$", user_text)
    if not m:
        log_emit("⚠ 未提取到具体命令", cls="error")
        speak("请说出完整终端命令，例如：终端执行 ls", engine=engine)
        return
    cmd = m.group(1).strip()
    log_emit(f"$ {cmd}", cls="user", state="thinking", state_label="EXECUTING")

    def _done(f):
        try:
            out = f.result()
            log_emit(out or "(执行完毕，无输出)", cls="bot")
            speak(out[:300] or "执行完毕，无输出", engine=engine)
        except Exception as e:
            log_emit(f"[错误] {e}", cls="error")
            speak(f"执行失败：{e}", engine="pyttsx3" if engine == "edge" else engine)

    fut = exec_pool.submit(safe_run, cmd)
    fut.add_done_callback(_done)


def cmd_shutdown():
    speak("好的，系统即将关闭。再见，先生。", engine="edge")
    log_emit("⏹ 服务即将关闭", cls="bot")
    os.kill(os.getpid(), signal.SIGINT)


def cmd_system_status():
    if not PSUTIL_OK:
        speak("系统监控模块未安装", engine="pyttsx3")
        return
    cpu = psutil.cpu_percent(interval=0.5)
    mem = psutil.virtual_memory()
    disk = psutil.disk_usage("/")
    text = (
        f"CPU 使用率：{cpu}%；"
        f"内存使用：{mem.percent}% ({mem.used // (1024**3)}/{mem.total // (1024**3)} GB)；"
        f"磁盘空间：{disk.percent}%"
    )
    log_emit(f"[系统状态] {text}", cls="speaking", state_label="SPEAKING")
    speak(text, engine=session_engine[0])


# ── 核心分发 ─────────────────────────────────────────────────────
def handle_transcript(user_text: str, engine: str = "edge"):
    txt = (user_text or "").strip()
    if not txt:
        return
    session_engine[0] = engine
    utxt = txt
    txt  = txt.lower()
    log_emit(f"[识别] {user_text}", cls="user")
    log_emit("", state="thinking", state_label="PROCESSING")

    if any(k in txt for k in ("暂停", "pause")):
        cmd_pause_music()
    elif any(k in txt for k in ("停止", "stop", "关掉音乐", "别放了")):
        cmd_stop_music()
    elif any(k in txt for k in ("下一首", "下一曲", "切歌", "next")):
        cmd_next_track()
    elif any(k in txt for k in ("音乐", "播放", "听歌", "music", "play")):
        cmd_play_music()
    elif any(k in txt for k in ("进度", "报告", "今日", "project", "status", "进度报告")):
        cmd_proj_status()
    elif any(k in txt for k in ("系统状态", "系统信息", "cpu", "内存")):
        cmd_system_status()
    elif any(k in txt for k in ("打开浏览器", "浏览器", "open browser", "打开网页", "github")):
        m = re.search(r"打开.*?([\w.-]+\.[a-z]{2,}(\/\S*)?)", utxt, re.I)
        url = "https://" + m.group(1) if m and "://" not in m.group(1) else (m.group(1) if m else "https://github.com")
        cmd_open_browser(url)
    elif any(k in txt for k in ("终端执行", "执行命令", "终端", "运行命令", "run ", "exec")):
        cmd_terminal_exec(utxt, engine=engine)
    elif any(k in txt for k in ("关闭", "退出", "再见", "关机", "shutdown", "bye", "exit", "quit")):
        cmd_shutdown()
    else:
        # 未命中规则 → 调 DeepSeek 模型兜底，并持久化本轮语音对话
        answer = ask_deepseek(user_text, engine)
        if answer:
            _append_history("user", user_text)
            _append_history("assistant", answer)
            speak(answer, engine=engine)
        else:
            # DeepSeek 也不可用，走硬编码
            resp = (
                "抱歉，我没有理解您的指令。"
                "您可以尝试：播放音乐、下一首、系统状态、项目进度、"
                "打开浏览器、终端执行 + 命令，或关闭。"
            )
            log_emit(resp, cls="bot")
            fallback_engine = "pyttsx3" if engine == "edge" and not EDGE_OK else engine
            speak(resp, engine=fallback_engine)


# ══════════════════════════════════════════════════════════════════
# Socket.IO 事件
# ══════════════════════════════════════════════════════════════════
@socketio.on("connect")
def on_connect():
    emit("console_log", {"text": "⚡ 后端就绪 · 等待语音指令…", "cls": "bot"})
    emit("status",      {"state": "idle", "label": "STANDBY"})


@socketio.on("ptt_start")
def on_ptt():
    emit("status", {"state": "listening", "label": "LISTENING"})
    log.info("PTT start")


@socketio.on("transcript")
def on_transcript(data):
    text   = (data or {}).get("text", "")
    engine = (data or {}).get("engine", "edge")
    # 后台线程处理，避免阻塞 socket 主 loop
    exec_pool.submit(handle_transcript, text, engine)


@socketio.on("status_update")
def on_status_update(data):
    log.info(f"前端同步状态：{data}")


@socketio.on("chat_message")
def on_chat_message(data):
    """前端文本聊天消息（备用通道，主要走 /api/chat HTTP）。"""
    text = (data or {}).get("text", "").strip()
    engine = (data or {}).get("engine", "edge")
    if not text:
        return
    log_emit(f"[识别] {text}", cls="user")
    log_emit("", state="thinking", state_label="PROCESSING")
    exec_pool.submit(handle_transcript, text, engine)


# ══════════════════════════════════════════════════════════════════
# Flask 路由
# ══════════════════════════════════════════════════════════════════
@app.route("/")
def index():
    return render_template("index.html")


# ── 文本对话 ────────────────────────────────────────────────────
@app.route("/api/chat", methods=["POST"])
def api_chat():
    """纯文本对话：接收 text，调 DeepSeek 返回文本、持久化并朗读。"""
    data = request.get_json(silent=True) or {}
    user_text = (data.get("text") or "").strip()
    if not user_text:
        return {"ok": False, "error": "空消息"}, 400
    engine = (data.get("engine") or "").strip() or "doubao"

    # 多轮记忆：拼入最近 8 轮
    with _chat_lock:
        _chat_history.append({"role": "user", "content": user_text})
        context_msgs = list(_chat_history[-16:])  # 最近 8 轮 = 16 条

    user_msg = _append_history("user", user_text)
    answer = _ask_deepseek_multi(context_msgs)
    if answer:
        with _chat_lock:
            _chat_history.append({"role": "assistant", "content": answer})
        assistant_msg = _append_history("assistant", answer)
        speak(answer, engine)  # 文字聊天也朗读回复
        return {"ok": True, "answer": answer, "engine": "deepseek",
                "user_id": user_msg["id"], "answer_id": assistant_msg["id"]}
    return {"ok": False, "error": "LLM 不可用"}, 502


# ── 原生 App 语音入口 ───────────────────────────────────────────
@app.route("/api/voice", methods=["POST"])
def api_voice():
    """原生 macOS App 的语音识别结果入口：走 handle_transcript（LLM + TTS）。"""
    data = request.get_json(silent=True) or {}
    text = (data.get("text") or "").strip()
    if not text:
        return {"ok": False, "error": "空消息"}, 400
    engine = (data.get("engine") or "").strip() or "doubao"
    exec_pool.submit(handle_transcript, text, engine)
    return {"ok": True}


def _ask_deepseek_multi(messages: list) -> str:
    """多轮 DeepSeek 调用。失败返回 None。"""
    if not _DSK_API_KEY:
        return None
    try:
        client = openai.OpenAI(api_key=_DSK_API_KEY, base_url=_DSK_BASE_URL, timeout=25,
                               http_client=httpx.Client(trust_env=_USE_PROXY))
        resp = client.chat.completions.create(
            model=_DSK_MODEL,
            messages=[{"role": "system", "content": _DSK_SYSTEM}] + messages,
            max_tokens=400,
            temperature=0.8,
        )
        return resp.choices[0].message.content.strip()
    except Exception as e:
        log_emit(f"[错误] DeepSeek 多轮调用失败：{e}", cls="error")
        return None


# ── 聊天历史（持久化 + 删除） ─────────────────────────────────
@app.route("/api/history", methods=["GET"])
def api_history_get():
    """返回全部持久化聊天记录。"""
    return {"ok": True, "messages": _load_history()}


@app.route("/api/history", methods=["DELETE"])
def api_history_clear():
    """清空全部聊天记录。"""
    _save_history([])
    return {"ok": True, "messages": []}


@app.route("/api/history/<msg_id>", methods=["DELETE"])
def api_history_delete(msg_id):
    """删除单条聊天记录。"""
    with _history_lock:
        remaining = [m for m in _load_history() if m.get("id") != msg_id]
        _save_history(remaining)
    return {"ok": True}


# ── 集中配置管理 ───────────────────────────────────────────────
_EDITABLE_PATHS = {
    "llm.provider",
    "llm.deepseek.api_key",
    "llm.deepseek.base_url",
    "llm.deepseek.model",
    "llm.volcark.api_key",
    "llm.volcark.base_url",
    "llm.volcark.model",
    "tts.engine",
    "tts.volc.app_id",
    "tts.volc.access_key",
    "tts.volc.resource_id",
    "tts.volc.speaker",
    "tts.volc.endpoint",
    "network.use_proxy",
}


def _merge_config_partial(current: dict, patch: dict) -> dict:
    """把 patch 里允许的字段合入 current（返回新 dict）。敏感字段空值 = 不修改。"""
    result = current

    def _apply(prefix: str, node: dict) -> None:
        nonlocal result
        for key, value in node.items():
            path = f"{prefix}.{key}" if prefix else key
            if isinstance(value, dict):
                _apply(path, value)
            elif path in _EDITABLE_PATHS:
                if value == "" and path in config.SENSITIVE_PATHS:
                    continue  # 敏感字段留空 = 保留原值
                if path == "network.use_proxy":
                    value = _as_bool(value)
                result = config.set_path(result, path, value)

    _apply("", patch)
    return result


@app.route("/api/config", methods=["GET"])
def api_config_get():
    """返回脱敏后的有效配置（含环境变量覆盖）。"""
    return {"ok": True, "config": config.masked(config.effective_config())}


@app.route("/api/config", methods=["PUT"])
def api_config_put():
    """接收部分更新，写入 config.json，热更新全局变量。"""
    data = request.get_json(silent=True) or {}
    if not isinstance(data, dict):
        return {"ok": False, "error": "请求体须为 JSON 对象"}, 400
    try:
        updated = _merge_config_partial(config.load_config(), data)
        config.save_config(updated)
    except (OSError, TypeError) as e:
        return {"ok": False, "error": f"保存失败：{e}"}, 500
    _reload_globals()
    return {"ok": True, "config": config.masked(config.effective_config())}


# ── 文件 / 图片上传 ─────────────────────────────────────────────
@app.route("/api/upload", methods=["POST"])
def api_upload():
    """接收文件，保存到 uploads/，解析文本内容返回。"""
    if "file" not in request.files:
        return {"ok": False, "error": "未收到文件"}, 400
    f = request.files["file"]
    if not f.filename:
        return {"ok": False, "error": "空文件名"}, 400

    fname = secure_filename(f.filename)
    ext = Path(fname).suffix.lower()
    if ext not in ALLOWED_EXTS:
        return {"ok": False, "error": f"不支持的格式：{ext}"}, 400

    # 保存
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    saved_name = f"{ts}_{fname}"
    save_path = _upload_dir / saved_name
    f.save(str(save_path))
    size = save_path.stat().st_size
    if size > MAX_UPLOAD_BYTES:
        save_path.unlink()
        return {"ok": False, "error": "文件超过 10MB 限制"}, 400

    # 解析内容
    content, kind = _extract_file_content(save_path, ext)
    mime = mimetypes.guess_type(fname)[0] or "application/octet-stream"

    return {
        "ok": True,
        "file": {
            "name": fname,
            "saved": saved_name,
            "size": size,
            "mime": mime,
            "kind": kind,            # "text" | "image"
            "content": content,      # 文本内容 or None
        },
    }


def _extract_file_content(path: Path, ext: str):
    """从文件提取文本。图片返回 None（由前端预览）。"""
    text_exts = {".txt", ".md", ".py", ".js", ".json", ".csv", ".log",
                 ".html", ".css", ".xml", ".yaml", ".yml", ".toml", ".ini",
                 ".sh", ".bat", ".rst", ".rtf"}
    if ext in text_exts:
        try:
            return path.read_text("utf-8", errors="replace")[:8000], "text"
        except Exception:
            return "(无法读取文件内容)", "text"
    if ext in {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"}:
        return None, "image"
    if ext == ".pdf":
        return _extract_pdf_text(path), "text"
    return f"(已接收文件：{ext} 格式，暂不支持文本提取)", "text"


def _extract_pdf_text(path: Path) -> str:
    """尝试用 PyPDF2 提取 PDF 文本。"""
    try:
        import PyPDF2
        reader = PyPDF2.PdfReader(str(path))
        parts = []
        for page in reader.pages:
            try:
                parts.append(page.extract_text() or "")
            except Exception:
                pass
        return "\n".join(parts)[:8000] or "(PDF 无可提取文本)"
    except ImportError:
        return "(未安装 PyPDF2，pip install PyPDF2 后可提取 PDF 文本)"
    except Exception as e:
        return f"(PDF 解析失败：{e})"


# ── 本地目录浏览 ─────────────────────────────────────────────────
@app.route("/api/browse")
def api_browse():
    """安全浏览本地目录（限制在 HOME 内）。"""
    req_path = request.args.get("path", "~")
    if req_path == "~":
        target = Path.home()
    else:
        target = Path(req_path).expanduser().resolve()
    # 安全校验：必须在 HOME 下
    home = Path.home().resolve()
    if not str(target).startswith(str(home)):
        return {"ok": False, "error": "路径越权，仅允许 HOME 下目录"}, 403
    if not target.exists():
        return {"ok": False, "error": "路径不存在"}, 404
    if target.is_file():
        return {"ok": True, "type": "file", "name": target.name, "size": target.stat().st_size}

    try:
        entries = sorted(target.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower()))
    except PermissionError:
        return {"ok": False, "error": "无权限访问"}, 403

    items = []
    for e in entries:
        try:
            st = e.stat()
            items.append({
                "name": e.name,
                "is_dir": e.is_dir(),
                "size": st.st_size if not e.is_dir() else 0,
                "mtime": datetime.fromtimestamp(st.st_mtime).strftime("%Y-%m-%d %H:%M"),
            })
        except Exception:
            pass
    return {"ok": True, "type": "dir", "path": str(target), "items": items}


# ── 文件搜索 ────────────────────────────────────────────────────
@app.route("/api/search")
def api_search():
    """在指定目录下按文件名搜索。"""
    q = request.args.get("q", "").strip()
    req_path = request.args.get("path", "~")
    if not q:
        return {"ok": False, "error": "空搜索词"}, 400

    if req_path == "~":
        target = Path.home()
    else:
        target = Path(req_path).expanduser().resolve()
    home = Path.home().resolve()
    if not str(target).startswith(str(home)):
        return {"ok": False, "error": "路径越权"}, 403
    if not target.is_dir():
        return {"ok": False, "error": "搜索路径不是目录"}, 400

    from time import time as _time
    import os
    results = []
    deadline = _time() + 8  # 8 秒超时
    # 跳过可能导致超时或权限问题的目录名
    skip_names = {'Library', 'CloudStorage', '.Trash', 'node_modules', '.venv',
                  '__pycache__', '.npm', '.cache', 'gems', 'site-packages'}
    q_lower = q.lower()
    try:
        for root, dirs, files in os.walk(target, followlinks=False):
            if _time() > deadline:
                break
            # 剪枝：原地修改 dirs 以阻止 os.walk 进入跳过的目录
            dirs[:] = [d for d in dirs if d not in skip_names and not d.startswith('.')]
            # 匹配文件
            for f in files:
                if q_lower in f.lower():
                    fp = os.path.join(root, f)
                    try:
                        st = os.stat(fp)
                        results.append({
                            "name": f,
                            "path": fp,
                            "is_dir": False,
                            "size": st.st_size,
                        })
                    except Exception:
                        pass
                    if len(results) >= 200:
                        break
            # 匹配目录名
            for d in dirs:
                if q_lower in d.lower():
                    dp = os.path.join(root, d)
                    results.append({
                        "name": d,
                        "path": dp,
                        "is_dir": True,
                        "size": 0,
                    })
                    if len(results) >= 200:
                        break
            if len(results) >= 200:
                break
    except Exception as e:
        return {"ok": False, "error": str(e)}, 500
    return {"ok": True, "results": results, "total": len(results)}


# ── 读取文本文件内容（预览用） ────────────────────────────────
@app.route("/api/read")
def api_read():
    """读取 HOME 内文本文件内容（预览用，限制大小与扩展名）。"""
    req_path = request.args.get("path", "")
    if not req_path:
        return {"ok": False, "error": "缺少路径"}, 400
    target = Path(req_path).expanduser().resolve()
    home = Path.home().resolve()
    if not str(target).startswith(str(home)):
        return {"ok": False, "error": "路径越权，仅允许 HOME 下文件"}, 403
    if not target.is_file():
        return {"ok": False, "error": "不是文件"}, 400
    ext = target.suffix.lower()
    text_exts = {".txt", ".md", ".py", ".js", ".ts", ".json", ".csv", ".log",
                 ".html", ".css", ".xml", ".yaml", ".yml", ".toml", ".ini",
                 ".sh", ".bat", ".rst", ".rtf", ".java", ".c", ".cpp", ".h",
                 ".go", ".rs", ".rb", ".php", ".sql", ".swift", ".kt"}
    if ext not in text_exts:
        return {"ok": False, "error": f"不支持预览 {ext} 格式"}, 400
    if target.stat().st_size > 256 * 1024:
        return {"ok": False, "error": "文件超过 256KB，仅支持预览小文件"}, 400
    try:
        content = target.read_text("utf-8", errors="replace")
    except Exception as e:
        return {"ok": False, "error": f"读取失败：{e}"}, 500
    return {"ok": True, "name": target.name, "path": str(target), "content": content}


# ── 本地相册（media/photos）─────────────────────────────────────
# 首次运行自动创建 media/ 与 media/photos/ 空目录，用户自行放入音乐/照片即可
MEDIA_DIR.mkdir(exist_ok=True)
PHOTOS_DIR = MEDIA_DIR / "photos"
PHOTOS_DIR.mkdir(exist_ok=True)
PHOTO_EXTS = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".heic", ".tiff"}


@app.route("/api/photos")
def api_photos():
    """列出 media/photos 目录下所有图片（按文件名排序）。"""
    if not PHOTOS_DIR.exists():
        return {"ok": True, "photos": []}
    items = []
    for f in sorted(PHOTOS_DIR.iterdir(), key=lambda p: p.name.lower()):
        if f.is_file() and f.suffix.lower() in PHOTO_EXTS:
            try:
                st = f.stat()
            except OSError:
                continue
            items.append({
                "name": f.name,
                "size": st.st_size,
                "mtime": datetime.fromtimestamp(st.st_mtime).strftime("%Y-%m-%d %H:%M"),
            })
    return {"ok": True, "photos": items}


@app.route("/api/photos/<path:name>")
def api_photo_file(name: str):
    """提供单张照片文件（仅限 media/photos 内，防目录穿越）。"""
    name = secure_filename(Path(name).name)
    target = (PHOTOS_DIR / name).resolve()
    if not str(target).startswith(str(PHOTOS_DIR.resolve())):
        return {"ok": False, "error": "路径越权"}, 403
    if not target.is_file() or target.suffix.lower() not in PHOTO_EXTS:
        return {"ok": False, "error": "文件不存在"}, 404
    mime = mimetypes.guess_type(target.name)[0] or "image/jpeg"
    return send_file(str(target), mimetype=mime)


# ── 火山引擎流式语音识别 ASR（国内直连、免 VPN）───────────────────
# 原生 App 只负责录音，把 16kHz/16bit/mono 原始 PCM 推到这里，
# 由后端转发给火山引擎并把文字回传。彻底绕开本机不稳定的
# 苹果 SFSpeechRecognizer（之前一直报 "No speech detected"）。
_ASR_SESSIONS: dict = {}
_ASR_LOCK = Lock()
_ASR_MAX_AGE = 90.0          # 会话最长存活（秒），超时强制回收


def _asr_reap() -> int:
    """回收僵尸会话（客户端异常退出、未调 stop），返回回收数量。

    否则孤儿会话会持续占用一个到火山引擎的 WebSocket 并累积音频。
    """
    now = time.time()
    with _ASR_LOCK:
        stale = [s for s, sess in _ASR_SESSIONS.items()
                 if now - getattr(sess, "created_at", now) > _ASR_MAX_AGE]
        victims = [_ASR_SESSIONS.pop(s) for s in stale]
    for sess in victims:
        try:
            sess.cancel()
        except Exception:
            pass
    if victims:
        log.info("🧹 ASR 回收 %d 个僵尸会话", len(victims))
    return len(victims)


@app.route("/api/asr/start", methods=["POST"])
def api_asr_start():
    """开启一次识别会话，返回 sid。"""
    _asr_reap()
    if not VOLC_APP_ID or not VOLC_ACCESS_KEY:
        return {"ok": False,
                "error": "未配置火山引擎密钥（tts.volc.app_id / access_key）"}, 500
    sess = asr_volc.VolcAsrSession(VOLC_APP_ID, VOLC_ACCESS_KEY)
    sess.on_partial = lambda t, _sid=sess.sid: socketio.emit(
        "asr_partial", {"sid": _sid, "text": t})
    if not sess.start():
        return {"ok": False, "error": sess.error or "ASR 连接失败"}, 502
    with _ASR_LOCK:
        _ASR_SESSIONS[sess.sid] = sess
    log.info("🎙️ ASR 会话开启 sid=%s", sess.sid[:8])
    return {"ok": True, "sid": sess.sid, "sample_rate": asr_volc.SAMPLE_RATE}


def _asr_get(sid: str):
    with _ASR_LOCK:
        return _ASR_SESSIONS.get(sid)


@app.route("/api/asr/chunk", methods=["POST"])
def api_asr_chunk():
    """接收一段原始 PCM（请求体即字节流），实时转发给火山引擎。"""
    sid = request.args.get("sid") or ""
    sess = _asr_get(sid)
    if sess is None:
        return {"ok": False, "error": "会话不存在或已结束"}, 404
    pcm = request.get_data()
    if pcm:
        sess.feed(pcm)
    return {"ok": True, "text": sess.text}


@app.route("/api/asr/stop", methods=["POST"])
def api_asr_stop():
    """结束会话，阻塞等待并返回最终识别文本。"""
    sid = request.args.get("sid") or ""
    with _ASR_LOCK:
        sess = _ASR_SESSIONS.pop(sid, None)
    if sess is None:
        return {"ok": False, "error": "会话不存在或已结束"}, 404
    text = sess.finish()
    log.info("🎙️ ASR 结束 sid=%s text=%r", sid[:8], text)
    socketio.emit("asr_final", {"sid": sid, "text": text})
    return {"ok": True, "text": text, "error": sess.error}


@app.route("/api/asr/cancel", methods=["POST"])
def api_asr_cancel():
    """放弃本次识别（用户中途取消）。"""
    sid = request.args.get("sid") or ""
    with _ASR_LOCK:
        sess = _ASR_SESSIONS.pop(sid, None)
    if sess is not None:
        sess.cancel()
    return {"ok": True}


@app.route("/api/asr/transcribe", methods=["POST"])
def api_asr_transcribe():
    """一次性识别：请求体为完整 16kHz/16bit/mono PCM，返回文本。

    供不便流式推流的客户端（或调试）使用。
    """
    if not VOLC_APP_ID or not VOLC_ACCESS_KEY:
        return {"ok": False,
                "error": "未配置火山引擎密钥（tts.volc.app_id / access_key）"}, 500
    pcm = request.get_data()
    if not pcm:
        return {"ok": False, "error": "请求体为空"}, 400
    text, err = asr_volc.transcribe_pcm(pcm, VOLC_APP_ID, VOLC_ACCESS_KEY)
    if err and not text:
        return {"ok": False, "error": err}, 502
    return {"ok": True, "text": text}

# ══════════════════════════════════════════════════════════════════
# 优雅退出
# ══════════════════════════════════════════════════════════════════
def _graceful_exit(signum=None, frame=None):
    log.info("🟢 J.A.R.V.I.S. 已安全关闭。再见，先生。")
    _stop_current()
    try:
        if PYGAME_OK and pygame.mixer.get_init():
            pygame.mixer.quit()
    except Exception:
        pass
    exec_pool.shutdown(wait=False)
    sys.exit(0)


signal.signal(signal.SIGINT,  _graceful_exit)
signal.signal(signal.SIGTERM, _graceful_exit)


# ══════════════════════════════════════════════════════════════════
# 启动入口
# ══════════════════════════════════════════════════════════════════
if __name__ == "__main__":
    print()
    print("=" * 58)
    print("  ⚡  J.A.R.V.I.S.  ·  Just A Rather Very Intelligent System")
    print("  🌐  浏览器打开  http://127.0.0.1:5001")
    print("  ⏹  Ctrl+C 退出")
    print("=" * 58)
    print()

    if not EDGE_OK and not PYTTSX3_OK:
        log.warning("⚠ 未检测到 edge-tts 与 pyttsx3，TTS 将不会工作")
    if not PYGAME_OK:
        log.warning("⚠ 未检测到 pygame，音乐播放回退到系统命令")
    if not PYTTSX3_OK:
        log.warning("⚠ 离线 TTS (pyttsx3) 不可用，请 pip install pyttsx3")

    # macOS/Chrome getUserMedia 需要 https 或 localhost；我们用 127.0.0.1 即可
    socketio.run(
        app,
        host="127.0.0.1",
        port=5001,
        debug=False,
        allow_unsafe_werkzeug=True,
        use_reloader=False,
    )


# ══════════════════════════════════════════════════════════════════
# 系统监控 —— 后台线程每秒推送 CPU / RAM / UMA / DISK
# ══════════════════════════════════════════════════════════════════
_stats_thread = None
_stats_thread_lock = Lock()
_net_prev = None

def _collect_stats():
    """采集一帧真实系统指标（CPU/RAM/DISK/负载/网络/进程/电量）。"""
    try:
        cpu  = psutil.cpu_percent(interval=None)
        mem  = psutil.virtual_memory()
        disk = psutil.disk_usage("/")
        load = os.getloadavg()
        net  = psutil.net_io_counters()
        procs = len(psutil.pids())
    except Exception:
        return {}

    global _net_prev
    net_now = {"sent": net.bytes_sent, "recv": net.bytes_recv}
    up = down = 0.0
    if _net_prev is not None:
        up   = round((net_now["sent"] - _net_prev["sent"]) / 1024.0, 1)
        down = round((net_now["recv"] - _net_prev["recv"]) / 1024.0, 1)
    _net_prev = net_now

    top_proc = ""
    try:
        top_proc = max(psutil.process_iter(["name", "cpu_percent"]),
                       key=lambda p: p.info["cpu_percent"] or 0).info["name"]
    except Exception:
        pass

    battery = None
    try:
        b = psutil.sensors_battery()
        if b is not None:
            battery = round(b.percent, 1)
    except Exception:
        pass

    return {
        "cpu":        round(cpu, 1),
        "ram":        round(mem.percent, 1),
        "ram_used":   round(mem.used / (1024 ** 3), 1),
        "ram_total":  round(mem.total / (1024 ** 3), 1),
        "uma":        round(mem.percent, 1),   # Apple Silicon UMA ≈ 内存占用
        "disk":       round(disk.percent, 1),
        "disk_used":  round(disk.used / (1024 ** 3), 1),
        "disk_total": round(disk.total / (1024 ** 3), 1),
        "load":       [round(x, 2) for x in load],
        "procs":      procs,
        "top_proc":   top_proc,
        "net_up":     up,     # KB/s 上行
        "net_down":   down,   # KB/s 下行
        "battery":    battery,
    }

def _stats_loop():
    while True:
        try:
            stats = _collect_stats()
            if stats:
                socketio.emit("stats_update", stats)
        except Exception:
            pass
        socketio.sleep(1)

def start_stats_thread():
    global _stats_thread
    with _stats_thread_lock:
        if _stats_thread is None:
            _stats_thread = socketio.start_background_task(_stats_loop)

# ── 统一的 WebSocket connect 处理器 ────────────────────────────
@socketio.on("connect")
def on_connect():
    start_stats_thread()
    emit("console_log", {"text": "⚡ 后端就绪 · 等待语音指令…", "cls": "bot"})
    emit("status",      {"state": "idle", "label": "STANDBY"})

