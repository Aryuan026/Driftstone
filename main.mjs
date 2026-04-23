import { spawn } from 'child_process';
import { app, BrowserWindow, dialog, shell } from 'electron';
import http from 'http';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const APP_ROOT = dirname(__filename);
const HOST = '127.0.0.1';
const PORT = 3460;
const APP_URL = `http://${HOST}:${PORT}/`;
const HEALTH_URL = `${APP_URL}api/health`;
const SERVER_ENTRY = join(APP_ROOT, 'server', 'index.js');

let mainWindow = null;
let backendProcess = null;
let quitting = false;

function makeLoadingHtml(message = '正在点亮 Hippocove…') {
  return `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html>
  <html lang="zh-CN">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width,initial-scale=1" />
      <title>Hippocove</title>
      <style>
        body {
          margin: 0;
          min-height: 100vh;
          display: grid;
          place-items: center;
          background: #f7f7f8;
          color: #0f172a;
          font-family: "PingFang SC", "SF Pro Text", "Segoe UI", "Helvetica Neue", sans-serif;
        }
        .card {
          width: min(640px, calc(100vw - 40px));
          padding: 28px 30px;
          border: 1px solid #e4e7ec;
          border-radius: 18px;
          background: #ffffff;
          box-shadow: 0 1px 2px rgba(16, 24, 40, 0.03);
        }
        h1 {
          margin: 0 0 10px;
          font-size: 24px;
          line-height: 1.1;
        }
        p {
          margin: 0;
          color: #667085;
          font-size: 14px;
          line-height: 1.7;
        }
      </style>
    </head>
    <body>
      <div class="card">
        <h1>Hippocove</h1>
        <p>${message}</p>
      </div>
    </body>
  </html>`)}`;
}

function waitForServer(timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get(HEALTH_URL, (res) => {
        res.resume();
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 500) {
          resolve();
          return;
        }
        if (Date.now() >= deadline) {
          reject(new Error(`本地后端没有在 ${timeoutMs / 1000}s 内就绪。`));
          return;
        }
        setTimeout(tick, 500);
      });
      req.on('error', () => {
        if (Date.now() >= deadline) {
          reject(new Error(`本地后端没有在 ${timeoutMs / 1000}s 内就绪。`));
          return;
        }
        setTimeout(tick, 500);
      });
      req.setTimeout(1500, () => {
        req.destroy();
      });
    };
    tick();
  });
}

function stopBackend() {
  if (!backendProcess) return;
  try {
    backendProcess.kill();
  } catch {}
  backendProcess = null;
}

function startBackend() {
  if (backendProcess) return;
  const dataRoot = join(app.getPath('userData'), 'hippocove-data');
  const obsidianRoot = join(app.getPath('userData'), 'obsidian-staging');
  backendProcess = spawn(process.execPath, [SERVER_ENTRY], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      HOST,
      PORT: String(PORT),
      HIPPOCOVE_DATA_ROOT: dataRoot,
      HIPPOCOVE_OBSIDIAN_ROOT: obsidianRoot
    },
    stdio: 'ignore',
    windowsHide: true
  });
  backendProcess.on('exit', () => {
    backendProcess = null;
    if (!quitting && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.loadURL(makeLoadingHtml('Hippocove 的本地后端已经停下来了。你可以关闭窗口后重新打开应用。')).catch(() => {});
    }
  });
}

async function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 980,
    minWidth: 1200,
    minHeight: 760,
    backgroundColor: '#f7f7f8',
    autoHideMenuBar: true,
    title: 'Hippocove',
    webPreferences: {
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });

  await mainWindow.loadURL(makeLoadingHtml('正在点亮本地工作台，第一次会稍慢一点。'));
  startBackend();
  try {
    await waitForServer();
    await mainWindow.loadURL(APP_URL);
  } catch (error) {
    await mainWindow.loadURL(makeLoadingHtml(`Hippocove 没能顺利点亮：${String(error?.message || error)}`));
    dialog.showErrorBox('Hippocove 启动失败', `本地后端没能顺利点亮。\n\n${String(error?.message || error)}`);
  }
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

app.on('second-instance', () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
});

app.whenReady().then(async () => {
  app.setName('Hippocove');
  await createMainWindow();
});

app.on('activate', async () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    await createMainWindow();
  }
});

app.on('before-quit', () => {
  quitting = true;
  stopBackend();
});
