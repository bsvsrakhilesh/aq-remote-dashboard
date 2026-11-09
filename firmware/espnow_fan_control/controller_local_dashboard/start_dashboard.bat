@echo off
cd /d "%~dp0"
echo Local fan dashboard: http://localhost:8765
echo Press Ctrl+C here to stop the local server.
python -m http.server 8765 --bind 127.0.0.1
