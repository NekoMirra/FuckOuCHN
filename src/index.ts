import { fileURLToPath } from 'url';
import path, { dirname } from 'path';

import { app, BrowserWindow, ipcMain } from 'electron';
import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

import { ims } from '@ims-tech-auto/core';
import type { RunnerProgressEvent } from '@ims-tech-auto/core';
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

let uiWindow: BrowserWindow | null = null;
const automationWindows: BrowserWindow[] = [];

let uiReady = false;
const bufferedProgress: RunnerProgressEvent[] = [];
let bufferedInit: { concurrency: number; ts: number } | null = null;

function sendToUi(channel: string, payload: any) {
  if (!uiWindow) return;
  // UI 未 ready 时先缓冲，避免漏事件导致“进度窗口不更新”。
  if (!uiReady) {
    if (channel === 'ims:ui:init') bufferedInit = payload;
    if (channel === 'ims:progress') bufferedProgress.push(payload as RunnerProgressEvent);
    return;
  }
  uiWindow.webContents.send(channel, payload);
}

function getConcurrency() {
  const raw = Number(process.env._CONCURRENCY ?? 1);
  const n = Number.isFinite(raw) ? Math.floor(raw) : 1;
  // 与 core 保持一致：允许 0 表示“自动并发（按课程数）”。
  // Electron 侧无法在创建窗口时提前知道课程数，因此这里预创建最多 6 个窗口。
  if (n === 0) return 6;
  return Math.min(Math.max(n, 1), 6);
}

function getShowWorkers() {
  const raw = String(process.env._SHOW_WORKERS ?? '0').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

function getUiTopMost() {
  const raw = String(process.env._UI_TOPMOST ?? '1').trim();
  return raw !== '0' && raw.toLowerCase() !== 'false';
}

app.on('second-instance', () => {
  if (uiWindow) {
    if (uiWindow.isMinimized()) uiWindow.restore();
    uiWindow.focus();
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

  const uiTopMost = getUiTopMost();
  const showWorkers = getShowWorkers();

  // 1) 先创建自动化窗口（Playwright 会操作这些窗口）
  for (let i = 0; i < windowCount; i++) {
    const w = new BrowserWindow({
      width: 1200,
      height: 900,
      title: `刷课窗口 W${i + 1}`,
      // 需要手动登录时至少保留一个可见窗口，其它 worker 窗口默认隐藏
      show: !Config.browser.headless && (showWorkers || i === 0),
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, 'preload.js'),
        additionalArguments: ['--ims-window=automation', `--ims-worker=${i + 1}`],
      },
    });
    automationWindows.push(w);
    await w.loadFile(path.join(__dirname, '/automation.html'));
    w.webContents.setAudioMuted(true);
  }

  // 2) 再创建 UI 窗口（只显示进度，不参与自动化）
  uiWindow = new BrowserWindow({
    width: 1200,
    height: 900,
    title: '进度面板',
    show: !Config.browser.headless,
    alwaysOnTop: uiTopMost,
    webPreferences: {
      nodeIntegration: false, // 禁用 Node.js Integration
      contextIsolation: true, // 启用上下文隔离
      preload: path.join(__dirname, 'preload.js'),
      additionalArguments: ['--ims-window=ui'],
    },
  });

  await uiWindow.loadFile(path.join(__dirname, '/index.html'));
  uiWindow.webContents.setAudioMuted(true);

  if (uiTopMost) {
    // Windows 下让 UI 更不容易被覆盖
    uiWindow.setAlwaysOnTop(true, 'floating');
  }

  // UI ready 握手：renderer 会发 ims:ui:ready。
  // 这里提前准备 init 数据，并在 ready 后补发。
  bufferedInit = { concurrency, ts: Date.now() };
  uiReady = false;
  bufferedProgress.length = 0;

  uiWindow.webContents.on('did-navigate', () => {
    // UI 页面被刷新/跳转后，需要重新握手
    uiReady = false;
  });

  uiWindow.on('closed', () => {
    uiWindow = null;
    uiReady = false;
    bufferedProgress.length = 0;
    bufferedInit = null;
  });

  // 使用 Playwright 连接窗口，示例连接到CDP端口（确保 Electron 打开时调试端口暴露）
  await connectToElectron().catch((err) => {
    console.error('Electron connection to Playwright failed:', err);
  });
}

ipcMain.on('ims:ui:ready', (evt) => {
  // 确保是当前 uiWindow 发来的
  if (!uiWindow) return;
  if (evt.sender.id !== uiWindow.webContents.id) return;

  uiReady = true;

  if (bufferedInit) {
    uiWindow.webContents.send('ims:ui:init', bufferedInit);
  }

  if (bufferedProgress.length) {
    for (const e of bufferedProgress.splice(0)) {
      uiWindow.webContents.send('ims:progress', e);
    }
  }
});

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

  const session = ims.login(browser, {
      ...Config.user,
      loginApi: Config.urls.login(),
      homeApi: Config.urls.home(),

    });

  // 转发 core 的进度事件到 UI
  session.onProgress((e: RunnerProgressEvent) => {
    sendToUi('ims:progress', e);
  });

  const runner = await session.start();

  await runner?.restart();

  app.exit();
}

app.whenReady().then(createWindow);

app.on('window-all-closed', async () => {
  app.quit();
});
