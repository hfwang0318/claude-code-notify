@echo off
REM ============================================================
REM  Claude Code Notify - Windows one-click build script
REM  Put this file, claude_notify_server.py, both hook scripts
REM  and app.ico together, then double-click to build
REM  dist\ClaudeCodeNotify.exe
REM ============================================================

cd /d %~dp0

REM ---------- 1. check python ----------
python --version >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Python not found. Please install Python 3.10+ and check "Add to PATH"
    pause
    exit /b 1
)

REM ---------- 2. install dependencies ----------
echo [1/3] Installing dependencies (PySide6 + paramiko + PyInstaller)...
python -m pip install --upgrade pip
python -m pip install PySide6 paramiko pyinstaller
if errorlevel 1 (
    echo [ERROR] Dependency installation failed. Check your network and retry.
    pause
    exit /b 1
)

REM ---------- 3. build ----------
echo [2/3] Building...
set ICON_ARG=
if exist app.ico set ICON_ARG=--icon app.ico

pyinstaller --noconfirm --clean --onefile --windowed --name ClaudeCodeNotify %ICON_ARG% --add-data "app.ico;." --add-data "claude_approval_hook.py;." --add-data "claude_notify_hook.py;." claude_notify_server.py

if errorlevel 1 (
    echo [ERROR] Build failed.
    pause
    exit /b 1
)

echo [3/3] Done!
echo.
echo Executable:  %cd%\dist\ClaudeCodeNotify.exe
echo Double-click to run. Closing the window minimizes it to the system tray.
echo.
pause
