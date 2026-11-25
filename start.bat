@echo off
rem PRISM one-shot launcher: install deps, fetch native Luau tools, build the UI, start the server.
rem   start.bat [--port 7777] [--host 127.0.0.1] [--workspace DIR]
cd /d "%~dp0"
if not exist node_modules call npm install
node tools\fetch-luau.mjs --optional
if not exist apps\web\dist\index.html call npm run build
node --import tsx apps\server\src\server.ts %*
