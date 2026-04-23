@echo off
setlocal

set "ROOT_DIR=%~dp0.."
for %%I in ("%ROOT_DIR%") do set "ROOT_DIR=%%~fI"
set "SERVER_DIR=%ROOT_DIR%\server"
set "TMP_DIR=%ROOT_DIR%\tmp\local-app"
set "PID_FILE=%TMP_DIR%\backend.pid"
set "LOG_FILE=%TMP_DIR%\backend.log"
set "APP_URL=http://127.0.0.1:3460/"

if not exist "%TMP_DIR%" mkdir "%TMP_DIR%"

where node >nul 2>nul
if errorlevel 1 (
  echo 这台机器还没装 Node.js，所以 Hippocove 还点不起来。
  echo 请先安装 Node.js 20+，再双击一次这个启动脚本。
  exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
  echo 这台机器还没装 npm，所以 Hippocove 还点不起来。
  echo 请先安装 Node.js 20+，再双击一次这个启动脚本。
  exit /b 1
)

powershell -NoProfile -Command "try { Invoke-WebRequest -UseBasicParsing '%APP_URL%' | Out-Null; exit 0 } catch { exit 1 }"
if %errorlevel%==0 (
  echo Hippocove 已经在跑，正在打开页面…
  start "" "%APP_URL%"
  exit /b 0
)

if not exist "%SERVER_DIR%\node_modules" (
  echo 首次启动，正在安装后端依赖…
  pushd "%SERVER_DIR%"
  call npm install
  if errorlevel 1 (
    popd
    exit /b 1
  )
  popd
)

if exist "%PID_FILE%" (
  for /f "usebackq delims=" %%I in ("%PID_FILE%") do set "EXISTING_PID=%%I"
  if defined EXISTING_PID (
    tasklist /FI "PID eq %EXISTING_PID%" | find "%EXISTING_PID%" >nul 2>nul
    if not errorlevel 1 (
      echo 检测到旧后端进程 %EXISTING_PID%，继续复用。
    ) else (
      del "%PID_FILE%" >nul 2>nul
    )
  )
)

if not exist "%PID_FILE%" (
  echo 正在启动 Hippocove 本地后端…
  powershell -NoProfile -Command "$p = Start-Process npm -ArgumentList 'run','start' -WorkingDirectory '%SERVER_DIR%' -WindowStyle Hidden -RedirectStandardOutput '%LOG_FILE%' -RedirectStandardError '%LOG_FILE%' -PassThru; Set-Content -Path '%PID_FILE%' -Value $p.Id"
)

set "READY=0"
for /L %%N in (1,1,25) do (
  powershell -NoProfile -Command "try { Invoke-WebRequest -UseBasicParsing '%APP_URL%' | Out-Null; exit 0 } catch { exit 1 }"
  if not errorlevel 1 (
    set "READY=1"
    goto :ready
  )
  timeout /t 1 /nobreak >nul
)

:ready
if "%READY%"=="1" (
  echo Hippocove 已就绪，正在打开前台。
  echo 旧实验台地址：%APP_URL%legacy/index.html
) else (
  echo 后端已尝试启动，但浏览器还没等到它回应。
  echo 你可以手动打开：%APP_URL%
)

start "" "%APP_URL%"
exit /b 0
