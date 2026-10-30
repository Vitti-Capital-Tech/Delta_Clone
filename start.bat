@echo off
cd /d "%~dp0"
if not exist node_modules call npm install
if not exist .env (
  echo No .env found - starting in MOCK mode ^(no login, nothing saved^).
  start "" http://localhost:5173
  node server/index.js --mock
) else (
  start "" http://localhost:5173
  node server/index.js
)
