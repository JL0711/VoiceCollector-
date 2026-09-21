@echo off
chcp 65001 >nul
cd /d "%~dp0"
where python >nul 2>nul && (python server.py & goto :eof)
where python3 >nul 2>nul && (python3 server.py & goto :eof)
where node >nul 2>nul && (node server.js & goto :eof)
echo 这台电脑上没有 Python 或 Node。
echo 请到 https://www.python.org/downloads/ 装一个 Python 3，再双击本文件。
pause
