@echo off
rem Optional: protect the dashboard with a password (TVs never need it)
rem set ADMIN_PASSWORD=change-me
cd /d "%~dp0"
if not exist node_modules (
  echo Installing dependencies...
  call npm install
)
node server.js
pause
