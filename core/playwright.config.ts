import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests', // 指定测试文件夹
  timeout: 0, // 每个测试的超时时间
  retries: 1, // 测试失败时的重试次数
  use: {
    launchOptions: process.env._CHROME_DEV
      ? {
        executablePath: process.env._CHROME_DEV,
        ignoreDefaultArgs: ['--headless=old'],
        args: ['--headless=new'],
      }
      : undefined,
    headless: true, // 是否启用无头模式
    viewport: { width: 1280, height: 720 }, // 浏览器窗口尺寸
    screenshot: 'only-on-failure', // 测试失败时截取屏幕
    video: 'retain-on-failure', // 测试失败时保存视频
    trace: 'on-first-retry' // 第一次重试时生成追踪文件
  },
  projects: [
    {
      name: 'Chromium',
      use: { browserName: 'chromium' } // 使用 Chromium 进行测试
    }
    // {
    //   name: 'Firefox',
    //   use: { browserName: 'firefox' },  // 使用 Firefox 进行测试
    // },
    // {
    //   name: 'WebKit',
    //   use: { browserName: 'webkit' },   // 使用 WebKit 进行测试
    // },
  ]
});
