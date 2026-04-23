@echo off
setlocal

set "ROOT_DIR=%~dp0.."
for %%I in ("%ROOT_DIR%") do set "ROOT_DIR=%%~fI"
set "TMP_DIR=%ROOT_DIR%\tmp\local-app"
set "PID_FILE=%TMP_DIR%\backend.pid"

if not exist "%PID_FILE%" (
  echo 没有找到 Hippocove 本地后端的 PID 记录。
  exit /b 0
)

for /f "usebackq delims=" %%I in ("%PID_FILE%") do set "PID=%%I"
if not defined PID (
  del "%PID_FILE%" >nul 2>nul
  echo PID 记录是空的，已经顺手清掉。
  exit /b 0
)

tasklist /FI "PID eq %PID%" | find "%PID%" >nul 2>nul
if errorlevel 1 (
  echo PID %PID% 已经不在运行，只清理记录。
) else (
  taskkill /PID %PID% /F >nul 2>nul
  echo 已停止 Hippocove 本地后端（PID %PID%）。
)

del "%PID_FILE%" >nul 2>nul
exit /b 0
