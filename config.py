# -*- coding: utf-8 -*-
"""集中配置管理：config.json 读写、脱敏、环境变量覆盖。

约定：
- 所有读取/合并函数返回新 dict，不就地修改输入（不可变语义）。
- 取值优先级：环境变量 > config.json > 默认值。
"""

import copy
import json
import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
CONFIG_PATH = BASE_DIR / "config.json"

# 默认配置（同时作为 config.example.json 的模板来源）
DEFAULT_CONFIG: dict = {
    "llm": {
        "provider": "deepseek",
        "deepseek": {
            "api_key": "",
            "base_url": "https://api.deepseek.com/v1",
            "model": "deepseek-chat",
        },
        "volcark": {
            "api_key": "",
            "base_url": "https://ark.cn-beijing.volces.com/api/v3",
            "model": "",
        },
    },
    "tts": {
        "engine": "pyttsx3",
        "volc": {
            "app_id": "",
            "access_key": "",
            "resource_id": "seed-tts-2.0",
            "speaker": "zh_male_m191_uranus_bigtts",
            "endpoint": "https://openspeech.bytedance.com/api/v3/tts/unidirectional/sse",
        },
    },
    "network": {
        "use_proxy": False,
    },
}

# 敏感字段（点路径）：GET /api/config 时脱敏，不返回完整值
SENSITIVE_PATHS = {
    "llm.deepseek.api_key",
    "llm.volcark.api_key",
    "tts.volc.access_key",
}

# 环境变量 -> 配置点路径（环境变量优先于 config.json）
ENV_OVERRIDES = {
    "DEEPSEEK_API_KEY": "llm.deepseek.api_key",
    "DEEPSEEK_BASE_URL": "llm.deepseek.base_url",
    "DEEPSEEK_MODEL": "llm.deepseek.model",
    "VOLC_APP_ID": "tts.volc.app_id",
    "VOLC_ACCESS_KEY": "tts.volc.access_key",
}


def _deep_merge(base: dict, overrides: dict) -> dict:
    """递归合并两个 dict，返回新 dict。"""
    result = copy.deepcopy(base)
    for key, value in overrides.items():
        if key in result and isinstance(result[key], dict) and isinstance(value, dict):
            result[key] = _deep_merge(result[key], value)
        else:
            result[key] = copy.deepcopy(value)
    return result


def load_config() -> dict:
    """加载 config.json；文件不存在或损坏时返回默认配置副本。"""
    cfg = copy.deepcopy(DEFAULT_CONFIG)
    if CONFIG_PATH.exists():
        try:
            data = json.loads(CONFIG_PATH.read_text("utf-8"))
        except (json.JSONDecodeError, OSError):
            return cfg
        if isinstance(data, dict):
            cfg = _deep_merge(cfg, data)
    return cfg


def save_config(cfg: dict) -> None:
    """原子写入 config.json（临时文件 + os.replace）。"""
    tmp = CONFIG_PATH.with_name(CONFIG_PATH.name + ".tmp")
    tmp.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), "utf-8")
    os.replace(tmp, CONFIG_PATH)


def get_path(cfg: dict, path: str):
    """按点路径读取值；路径不存在返回 None。"""
    node = cfg
    for part in path.split("."):
        if not isinstance(node, dict) or part not in node:
            return None
        node = node[part]
    return node


def set_path(cfg: dict, path: str, value) -> dict:
    """按点路径写入，返回新 dict（不可变）。"""
    result = copy.deepcopy(cfg)
    node = result
    parts = path.split(".")
    for part in parts[:-1]:
        node = node.setdefault(part, {})
    node[parts[-1]] = value
    return result


def apply_env_overrides(cfg: dict) -> dict:
    """应用环境变量覆盖，返回新 dict。"""
    result = copy.deepcopy(cfg)
    for env_key, path in ENV_OVERRIDES.items():
        val = os.environ.get(env_key)
        if val:
            result = set_path(result, path, val)
    return result


def effective_config() -> dict:
    """运行时有效配置 = config.json + 环境变量覆盖。"""
    return apply_env_overrides(load_config())


def mask_secret(value: str) -> dict:
    """脱敏单个密钥为 {configured, value}。"""
    if not value:
        return {"configured": False, "value": ""}
    s = str(value)
    masked = "***" + s[-4:] if len(s) > 4 else "***"
    return {"configured": True, "value": masked}


def masked(cfg: dict) -> dict:
    """返回脱敏后的配置副本：敏感字段变为 {configured, value}。"""
    result = copy.deepcopy(cfg)
    for path in SENSITIVE_PATHS:
        raw = get_path(result, path)
        if isinstance(raw, str):
            result = set_path(result, path, mask_secret(raw))
    return result
