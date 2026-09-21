#!/bin/zsh
cd "$(dirname "$0")"
if command -v python3 >/dev/null 2>&1; then
  exec python3 server.py
elif command -v node >/dev/null 2>&1; then
  exec node server.js
elif command -v python >/dev/null 2>&1; then
  exec python server.py
else
  echo "这台电脑上没有 Python 或 Node。"
  echo "请到 https://www.python.org/downloads/ 装一个 Python 3，再双击本文件。"
  echo "（按回车关闭）"; read
fi
