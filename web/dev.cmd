@echo off
set PATH=C:\CC\tools\node;%PATH%
cd /d "%~dp0"
call npm run dev -- --host 127.0.0.1 --strictPort
