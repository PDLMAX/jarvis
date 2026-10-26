# -*- coding: utf-8 -*-
"""config 模块单元测试：加载/保存/脱敏/环境变量优先级。"""

import json

import pytest

import config


@pytest.fixture
def isolated_config(tmp_path, monkeypatch):
    """把 CONFIG_PATH 指向临时目录，隔离测试对真实 config.json 的影响。"""
    path = tmp_path / "config.json"
    monkeypatch.setattr(config, "CONFIG_PATH", path)
    return path


def test_load_config_missing_returns_default(isolated_config):
    cfg = config.load_config()
    assert cfg["llm"]["deepseek"]["model"] == "deepseek-chat"
    assert cfg["tts"]["volc"]["speaker"].startswith("zh_male")
    assert cfg["llm"]["provider"] == "deepseek"


def test_save_and_load_roundtrip(isolated_config):
    cfg = config.load_config()
    cfg["llm"]["deepseek"]["api_key"] = "sk-test-1234"
    config.save_config(cfg)
    loaded = config.load_config()
    assert loaded["llm"]["deepseek"]["api_key"] == "sk-test-1234"


def test_load_config_merges_defaults_for_missing_fields(isolated_config):
    isolated_config.write_text(
        json.dumps({"llm": {"deepseek": {"api_key": "sk-file-1111"}}}), "utf-8"
    )
    cfg = config.load_config()
    # 缺失字段被默认值补齐，存在字段被覆盖
    assert cfg["llm"]["deepseek"]["api_key"] == "sk-file-1111"
    assert cfg["llm"]["deepseek"]["model"] == "deepseek-chat"
    assert cfg["llm"]["volcark"]["base_url"].startswith("https://ark")


def test_env_override_takes_priority(isolated_config, monkeypatch):
    monkeypatch.setenv("DEEPSEEK_API_KEY", "sk-env-9999")
    isolated_config.write_text(
        json.dumps({"llm": {"deepseek": {"api_key": "sk-file-1111"}}}), "utf-8"
    )
    cfg = config.effective_config()
    assert cfg["llm"]["deepseek"]["api_key"] == "sk-env-9999"


def test_masked_hides_secret_and_keeps_plain(isolated_config):
    cfg = config.load_config()
    cfg["llm"]["deepseek"]["api_key"] = "sk-abcdef123456"
    cfg["tts"]["volc"]["access_key"] = "volc-secret-key-9999"
    m = config.masked(cfg)
    secret = m["llm"]["deepseek"]["api_key"]
    assert secret == {"configured": True, "value": "***3456"}
    # 完整密钥不出现在脱敏结果中
    assert "abcdef123456" not in json.dumps(m)
    assert "volc-secret-key-9999" not in json.dumps(m)
    # 非敏感字段原样保留
    assert m["llm"]["deepseek"]["model"] == "deepseek-chat"


def test_masked_empty_secret_is_not_configured(isolated_config):
    m = config.masked(config.load_config())
    assert m["llm"]["deepseek"]["api_key"] == {"configured": False, "value": ""}
    assert m["tts"]["volc"]["access_key"] == {"configured": False, "value": ""}


def test_masked_does_not_mutate_original(isolated_config):
    cfg = config.load_config()
    cfg["llm"]["deepseek"]["api_key"] = "sk-abcdef123456"
    config.masked(cfg)
    assert cfg["llm"]["deepseek"]["api_key"] == "sk-abcdef123456"


def test_atomic_write_leaves_no_tmp_file(isolated_config):
    config.save_config(config.load_config())
    assert not isolated_config.with_name("config.json.tmp").exists()
    data = json.loads(isolated_config.read_text("utf-8"))
    assert data["llm"]["provider"] == "deepseek"


def test_corrupt_config_falls_back_to_default(isolated_config):
    isolated_config.write_text("{not valid json", "utf-8")
    cfg = config.load_config()
    assert cfg["llm"]["deepseek"]["model"] == "deepseek-chat"
