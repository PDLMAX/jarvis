@echo off
REM ── J.A.R.V.I.S. 一键启动脚本 (Windows) ─────────────────────────────────
cd /d %~dp0

if not exist .venv (
    echo [首次运行] 创建 Python 虚拟环境...
    python -m venv .venv
)

call .venv\Scripts\activate

echo [检查依赖] ...
pip install -r requirements.txt -q

echo.
echo ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo   J.A.R.V.I.S. 已上线
echo   浏览器打开  http://127.0.0.1:5000
echo   Ctrl+C 关闭
echo ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo.

python app.py
