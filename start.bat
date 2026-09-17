@echo off
rem To protect the dashboard with a password, create a file named .env next to this
rem script containing:  ADMIN_PASSWORD=your-password   (TVs never need it)
cd /d "%~dp0"
if not exist node_modules (
  echo Installing dependencies...
  call npm install
)
node server.js
pause
