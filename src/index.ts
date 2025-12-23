import { fileURLToPath } from 'url';
import path, { dirname } from 'path';

import { app, BrowserWindow } from 'electron';
import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

import { ims } from '@ims-tech-auto/core';
import AIModel from '@ims-tech-auto/core/ai/AIModel.js';
import HumanBehaviorPlugin from '@ims-tech-auto/core/plugins/HumanBehaviorPlugin.js';
import Config from '@ims-tech-auto/core/config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.join(dirname(__filename), '..', '..');

const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  // 如果无法获得锁，说明已有实例在运行
  app.quit();
}

let mainWindow: BrowserWindow | null = null;
const workerWindows: BrowserWindow[] = [];

function getConcurrency() {
  const raw = Number(process.env._CONCURRENCY ?? 1);
  const n = Number.isFinite(raw) ? Math.floor(raw) : 1;
  return Math.min(Math.max(n, 1), 6);
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});
{
  const { appendSwitch } = app.commandLine;
  appendSwitch('remote-debugging-port', '9222');
  appendSwitch('no-sandbox');
  appendSwitch('disable-gpu');
  appendSwitch('disable-software-rasterizer');
  appendSwitch('disable-gpu-compositing');
  appendSwitch('disable-accelerated-video-decode');
  appendSwitch('disable-accelerated-video-encode');

  // 某些 Windows 环境下禁用 GPU 后仍可能出现视频渲染/解码异常，强制使用 SwiftShader。
  // 这些开关不会保证彻底消灭 ffmpeg 日志，但通常能减少因 GPU/ANGLE 导致的兼容性问题。
  appendSwitch('use-angle', 'swiftshader');
  appendSwitch('use-gl', 'swiftshader');
}

async function createWindow() {
  const concurrency = getConcurrency();
  const windowCount = Math.max(1, concurrency);

  // 主窗口
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 900,
    show: !Config.browser.headless,
    webPreferences: {
      nodeIntegration: false, // 禁用 Node.js Integration
      contextIsolation: true, // 启用上下文隔离
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  await mainWindow.loadFile(path.join(__dirname, '/index.html'));
  mainWindow.webContents.setAudioMuted(true);

  // 额外窗口（默认隐藏），用于并发 worker：CDP 下无法通过 Target.createTarget 新建页面。
  // 这些窗口与主窗口同一 session，Playwright 连接后可直接拿到多个 pages。
  for (let i = 1; i < windowCount; i++) {
    const w = new BrowserWindow({
      width: 1200,
      height: 900,
      // 避免并发时弹出一堆窗口；需要可视化调试可自行改为 true。
      show: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, 'preload.js'),
      },
    });
    workerWindows.push(w);
    await w.loadFile(path.join(__dirname, '/index.html'));
    w.webContents.setAudioMuted(true);
  }

  // 使用 Playwright 连接窗口，示例连接到CDP端口（确保 Electron 打开时调试端口暴露）
  await connectToElectron().catch((err) => {
    console.error('Electron connection to Playwright failed:', err);
  });
}

async function waitForCDP(url: string, timeout = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch (e) {
      // ignore
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Timeout waiting for CDP at ${url}`);
}

async function connectToElectron() {
  const cdpHost = '127.0.0.1';
  const cdpPort = '9222';
  const cdpUrl = `http://${cdpHost}:${cdpPort}`;

  console.log('Waiting for CDP...');
  await waitForCDP(cdpUrl + '/json/version');
  console.log('CDP is ready.');

  // Fetch the WebSocket URL manually
  const response = await fetch(cdpUrl + '/json/version');
  if (!response.ok) {
    throw new Error(`Failed to fetch CDP version info: ${response.statusText}`);
  }
  const json: any = await response.json();
  const wsEndpoint = json.webSocketDebuggerUrl;

  if (!wsEndpoint) {
    throw new Error('Could not find webSocketDebuggerUrl in CDP response');
  }

  console.log(`Connecting to CDP at ${wsEndpoint}`);

  // 连接到 Electron 的 CDP 端口
  const browser = await chromium
    .use(StealthPlugin())
    .use(HumanBehaviorPlugin())
    .connectOverCDP(wsEndpoint, {
      slowMo: 240,
      timeout: 1000 * 60 * 2,
      headers: {
        Accept: 'application/json',
        Connection: 'keep-alive',
      },
    });

  await AIModel.init(true);

  const runner = await ims
    .login(browser, {
      ...Config.user,
      loginApi: Config.urls.login(),
      homeApi: Config.urls.home(),
    })
    .start();

  await runner?.restart();

  app.exit();
}

app.whenReady().then(createWindow);

app.on('window-all-closed', async () => {
  app.quit();
});
