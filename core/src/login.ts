import { Browser, Cookie } from 'playwright';

import * as fs from 'fs';
import path from 'path';

const cookieFilename = path.join(process.cwd(), '.cookies.txt');

interface LoginConfig {
  account?: string;
  password?: string;
  loginApi: string;
  homeApi: string;
}

async function login(browser: Browser, config: LoginConfig) {
  const context =
    browser.contexts().length == 0
      ? await browser.newContext()
      : browser.contexts()[0];

  const cookies = await restoreCookies();

  if (cookies.length != 0) {
    await context.clearCookies();

    await context.addCookies(filterCookies(cookies, ['session'])).catch((e) => {
      console.warn('解析Cookie文件失败:', e);
      fs.rmSync(cookieFilename);
    });
  }

  // Electron 多窗口 + CDP 场景：需要避开 UI 窗口。
  // preload 会给 automation 窗口设置 window.name = 'IMS_AUTOMATION'。
  let page = context.pages().length == 0 ? await context.newPage() : context.pages()[0];

  for (const p of context.pages()) {
    const name = await p
      .evaluate(() => window.name)
      .then(String)
      .catch(() => '');
    if (name === 'IMS_AUTOMATION') {
      page = p;
      break;
    }
  }

  await page.goto(config.homeApi, { timeout: 1000 * 60 * 10 });

  if (!RegExp(`^${config.loginApi}`).test(page.url())) {
    console.log('已经登陆');
    return page;
  }

  console.warn('需要登陆');

  const agree = page.locator('#agreeCheckBox').first();
  await agree.setChecked(true);

  const { account, password } = config;

  if (account && password) {
    await page.getByPlaceholder('请输入登录名').fill(account);
    await page.getByPlaceholder('请输入登录密码').fill(password);
    await page.getByRole('button', { name: /^\s*登\s*录\s*$/ }).click();
  } else {
    console.warn('缺少账号或密码, 需要手动输入');
  }

  // 等待跳转到主页
  await page.waitForURL(config.homeApi, { timeout: 1000 * 60 * 5 });

  return page;
}

async function storeCookies(cookies: Array<Cookie>) {
  const s = JSON.stringify(cookies);

  fs.writeFileSync(cookieFilename, s);
}

async function restoreCookies(): Promise<Array<Cookie>> {
  if (fs.existsSync(cookieFilename)) {
    // playwright 不识别null,需要转换undefined
    const cookies: Cookie[] = JSON.parse(
      String(fs.readFileSync(cookieFilename)),
    );
    cookies.forEach((cookie) => {
      for (const k in cookie) {
        (cookie as any)[k] = cookie[k as keyof Cookie] ?? void 0;
      }

      // 不识别小写开头,需要转 ___*( ￣皿￣)/#____
      cookie.sameSite = {
        STRICT: 'Strict',
        LAX: 'Lax',
        None: 'None',
      }[cookie.sameSite.toUpperCase()] as any;
    });

    return cookies;
  }
  return [];
}

/**
 *
 * @param cookies Cookie数组
 * @param names 需要哪些Cookie匹配的name
 * @returns 过滤后符合names的Cookie数组
 */
function filterCookies(cookies: Array<Cookie>, names: string[]) {
  return cookies.filter((cookie) => names.includes(cookie.name));
}

export { LoginConfig, filterCookies, login, restoreCookies, storeCookies };
