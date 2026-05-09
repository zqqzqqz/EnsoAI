@echo off
chcp 65001 >nul 2>&1
title EnsoAI Dev Server

cd /d "%~dp0"

echo.
echo ========================================
echo   EnsoAI Dev Server
echo ========================================
echo.

if not exist "node_modules" (
    echo [INFO] Installing dependencies...
    call pnpm install
    echo.
)

echo [INFO] Starting dev server...
echo [INFO] Press Ctrl+C to stop
echo.

call pnpm dev

echo.
echo [INFO] Server stopped
pause
