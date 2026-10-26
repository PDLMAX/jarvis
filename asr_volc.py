"""火山引擎大模型流式语音识别（Volcengine sauc bigmodel）客户端。

复用 config.json 里 tts.volc 的 app_id / access_key（与豆包 TTS 同一套密钥），
国内直连、无需 VPN，彻底替代在本机表现不稳定的苹果 SFSpeechRecognizer。

协议要点（均为实测踩坑结论，勿轻易改动）：
  * 帧头共 8 字节：4 字节标志位 + 4 字节 big-endian 的 payload 长度。
    漏掉长度字段会导致服务端把 gzip 魔数当成长度，报
    "declared body size does not match actual body size"。
  * 音频分片必须【不压缩】(compression=0)。用 gzip 压缩音频时服务端会正常
    收下并递增 duration，但 text 永远为空——极难排查。
  * 音频分片 serialization=0（原始字节）；首个配置包 serialization=1(JSON)+gzip。
  * 结束信号：AUDIO_ONLY_REQUEST + flags=NEG_SEQUENCE(0b0010) + 空 payload。
  * 响应帧可能带 4 字节 sequence，payload 前会残留杂散字节，
    解析时要定位第一个 '{' 再做 JSON 解析。
  * resource_id 必须是 volc.bigasr.sauc.duration；
    volc.bigasr.sauc / volc.streamasr / volc.asr 均返回 400 not allowed。
"""
from __future__ import annotations

import gzip
import json
import logging
import queue
import struct
import threading
import time
import uuid

import websocket

log = logging.getLogger("jarvis.asr")

ASR_URL = "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel"
ASR_RESOURCE_ID = "volc.bigasr.sauc.duration"

# ── 二进制协议常量 ──────────────────────────────────────────────
FULL_CLIENT_REQUEST = 0b0001
AUDIO_ONLY_REQUEST = 0b0010
FULL_SERVER_RESPONSE = 0b1001
ERROR_MESSAGE = 0b1111

FLAG_NO_SEQUENCE = 0b0000
FLAG_NEG_SEQUENCE = 0b0010      # 结束信号

COMP_GZIP = 0b0001
COMP_NONE = 0b0000
SER_JSON = 0b0001
SER_NONE = 0b0000

SAMPLE_RATE = 16000
CHANNELS = 1
BITS = 16


def _build_frame(msg_type: int, payload: bytes, flags: int = FLAG_NO_SEQUENCE,
                 compression: int = COMP_NONE, serialization: int = SER_NONE) -> bytes:
    """构造 8 字节帧头 + payload。"""
    hdr = bytearray(8)
    hdr[0] = (0b0001 << 4) | 0b0001          # protocol version 1, header size 1
    hdr[1] = (msg_type << 4) | flags
    hdr[2] = (compression << 4) | serialization
    hdr[3] = 0x00
    struct.pack_into(">I", hdr, 4, len(payload))
    return bytes(hdr) + payload


def _extract_payload(message: bytes) -> tuple[int, bytes]:
    """解析响应帧，返回 (message_type, payload)。

    响应帧可能是 8 字节头（无 sequence）或 12 字节头（带 sequence），
    用「偏移 + 声明长度 == 总长度」来自动判定。
    """
    if len(message) < 8:
        return -1, b""
    msg_type = (message[1] >> 4) & 0x0F
    compression = (message[2] >> 4) & 0x0F

    payload = b""
    for off in (8, 12):
        if len(message) < off + 4:
            continue
        size = struct.unpack(">I", message[off:off + 4])[0]
        if off + size == len(message):
            payload = message[off:off + size]
            break
    else:
        payload = message[8:]

    if compression == COMP_GZIP and payload[:2] == b"\x1f\x8b":
        try:
            payload = gzip.decompress(payload)
        except Exception:
            pass
    return msg_type, payload


class VolcAsrSession:
    """一次完整的语音识别会话。

    用法：
        s = VolcAsrSession(app_id, access_key, on_partial=cb)
        s.start()
        s.feed(pcm_bytes)   # 16kHz/16bit/mono 原始 PCM，可多次
        text = s.finish()   # 阻塞直到拿到最终文本
    """

    def __init__(self, app_id: str, access_key: str,
                 on_partial=None, timeout: float = 15.0):
        self.app_id = str(app_id)
        self.access_key = access_key
        self.on_partial = on_partial
        self.timeout = timeout

        self.sid = uuid.uuid4().hex
        self.connect_id = str(uuid.uuid4())
        self.created_at = time.time()

        self._q: queue.Queue = queue.Queue()
        self._text = ""
        self._final = threading.Event()
        self._error: str | None = None
        self._closing = False
        self._ws = None
        self._started = False

    # ── 对外接口 ────────────────────────────────────────────────
    def start(self) -> bool:
        """建立 WebSocket 连接并发送配置包。失败返回 False。"""
        headers = [
            f"X-Api-App-Key: {self.app_id}",
            f"X-Api-Access-Key: {self.access_key}",
            f"X-Api-Resource-Id: {ASR_RESOURCE_ID}",
            f"X-Api-Connect-Id: {self.connect_id}",
        ]
        self._ws = websocket.WebSocketApp(
            ASR_URL, header=headers,
            on_open=self._on_open,
            on_message=self._on_message,
            on_error=self._on_error,
            on_close=self._on_close,
        )
        t = threading.Thread(target=self._run, daemon=True,
                             name=f"asr-{self.sid[:8]}")
        t.start()

        # 等待连接就绪（最多 5 秒）
        for _ in range(50):
            if self._started or self._error:
                break
            time.sleep(0.1)
        if self._error:
            log.warning("ASR 连接失败: %s", self._error)
            return False
        return self._started

    def feed(self, pcm: bytes) -> None:
        """送入一段 16kHz/16bit/mono 原始 PCM。"""
        if not pcm or self._closing:
            return
        self._q.put(pcm)

    def finish(self) -> str:
        """通知服务端音频结束，阻塞等待最终文本。"""
        self._q.put(None)          # 哨兵：触发结束信号
        self._final.wait(timeout=self.timeout)
        self._closing = True
        try:
            if self._ws:
                self._ws.close()
        except Exception:
            pass
        return self._text

    def cancel(self) -> None:
        self._closing = True
        self._final.set()
        try:
            if self._ws:
                self._ws.close()
        except Exception:
            pass

    @property
    def error(self) -> str | None:
        return self._error

    @property
    def text(self) -> str:
        """当前已识别到的文本（增量）。"""
        return self._text

    # ── WebSocket 回调 ──────────────────────────────────────────
    def _run(self):
        try:
            websocket.setdefaulttimeout(30)
            self._ws.run_forever(ping_interval=0, suppress_origin=True)
        except Exception as e:                       # pragma: no cover
            if not self._error:
                self._error = f"ASR 运行异常: {e}"
        finally:
            self._final.set()

    def _on_open(self, ws):
        cfg = {
            "user": {"uid": f"jarvis-{self.sid[:8]}"},
            "audio": {
                "format": "pcm",
                "rate": SAMPLE_RATE,
                "bits": BITS,
                "channel": CHANNELS,
                "codec": "raw",
            },
            "request": {
                "model_name": "bigmodel",
                "enable_punc": True,
                "show_utterances": False,
            },
        }
        body = gzip.compress(json.dumps(cfg).encode("utf-8"))
        ws.send(_build_frame(FULL_CLIENT_REQUEST, body,
                             compression=COMP_GZIP, serialization=SER_JSON),
                opcode=websocket.ABNF.OPCODE_BINARY)
        self._started = True
        log.info("ASR 已连接 connect_id=%s", self.connect_id)

        # 发送线程：从队列取音频实时转发（音频本身来自麦克风，天然是实时节奏）
        threading.Thread(target=self._sender, args=(ws,), daemon=True,
                         name=f"asr-send-{self.sid[:8]}").start()

    def _sender(self, ws):
        while not self._closing:
            try:
                item = self._q.get(timeout=0.2)
            except queue.Empty:
                continue
            if item is None:                 # 结束信号
                try:
                    ws.send(_build_frame(AUDIO_ONLY_REQUEST, b"",
                                         flags=FLAG_NEG_SEQUENCE,
                                         compression=COMP_NONE,
                                         serialization=SER_NONE),
                            opcode=websocket.ABNF.OPCODE_BINARY)
                except Exception as e:
                    log.warning("ASR 发送结束信号失败: %s", e)
                # 给服务端一点时间吐最终结果
                self._final.wait(timeout=self.timeout)
                return
            try:
                # 关键：音频分片不压缩
                ws.send(_build_frame(AUDIO_ONLY_REQUEST, item,
                                     compression=COMP_NONE,
                                     serialization=SER_NONE),
                        opcode=websocket.ABNF.OPCODE_BINARY)
            except Exception as e:
                log.warning("ASR 发送音频失败: %s", e)
                self._error = self._error or f"发送音频失败: {e}"
                self._final.set()
                return

    def _on_message(self, ws, message):
        if isinstance(message, str):
            return
        msg_type, payload = _extract_payload(message)
        if msg_type == ERROR_MESSAGE:
            txt = payload.decode("utf-8", "ignore")
            log.warning("ASR 服务端错误: %s", txt[:300])
            if not self._error:
                self._error = txt[:300]
            self._final.set()
            return
        if not payload:
            return
        txt = payload.decode("utf-8", "ignore")
        # payload 前可能残留 sequence 字节，定位 JSON 起点
        idx = txt.find("{")
        if idx < 0:
            return
        try:
            obj = json.loads(txt[idx:])
        except Exception:
            return

        if "error" in obj and not self._error:
            self._error = json.dumps(obj["error"], ensure_ascii=False)[:300]

        res = obj.get("result")
        if isinstance(res, dict):
            t = (res.get("text") or "").strip()
            if t and t != self._text:
                self._text = t
                if self.on_partial:
                    try:
                        self.on_partial(t)
                    except Exception:
                        pass

        ai = obj.get("audio_info") or {}
        # definite=True 的 utterance 表示该句已定稿
        utts = res.get("utterances") if isinstance(res, dict) else None
        is_definite = any(u.get("definite") for u in utts) if utts else False
        if ai.get("is_end") is True or obj.get("is_end") is True or is_definite:
            self._final.set()

    def _on_error(self, ws, err):
        # 正常结束时服务端会发 close 帧 "finish last sequence"，不算错误
        s = str(err)
        if "finish last sequence" in s:
            return
        log.warning("ASR WebSocket 错误: %s", s[:200])
        if not self._error:
            self._error = s[:200]

    def _on_close(self, ws, code, reason):
        self._final.set()


# ── 一次性识别（整段音频，非流式）───────────────────────────────
def transcribe_pcm(pcm: bytes, app_id: str, access_key: str,
                   timeout: float = 20.0) -> tuple[str, str | None]:
    """把一整段 16kHz/16bit/mono PCM 识别成文字。

    返回 (text, error)。内部按 200ms 分片、按实时节奏投喂。
    """
    sess = VolcAsrSession(app_id, access_key, timeout=timeout)
    if not sess.start():
        return "", sess.error or "ASR 连接失败"

    chunk_bytes = SAMPLE_RATE * 2 * CHANNELS * 200 // 1000   # 200ms
    for i in range(0, len(pcm), chunk_bytes):
        sess.feed(pcm[i:i + chunk_bytes])
        time.sleep(0.02)          # 轻微节流，避免瞬时灌满
    text = sess.finish()
    return text, sess.error
