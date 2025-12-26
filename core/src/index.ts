import 'source-map-support/register.js';
import chalk from 'chalk';
import { Browser, Locator, Page } from 'playwright-core';
import { format } from 'util';
import { exit } from 'process';

import Config, { API_BASE_URL } from './config.js';
import * as Activity from './activity.js';
import * as Processor from './course/processor.js';
import * as Search from './course/search.js';
import { filterCookies, login, LoginConfig, storeCookies } from './login.js';
import { errorWithRetry, input, waitForSPALoaded } from './utils.js';
import { CourseInfo } from './course/search.js';
import { ActivityInfo } from './activity.js';

type RunnerProgressEvent =
  | {
    kind: 'groupStart';
    groupTitle: string;
    totalCourses: number;
    concurrency: number;
    ts: number;
  }
  | {
    kind: 'groupEnd';
    groupTitle: string;
    ts: number;
  }
  | {
    kind: 'groupError';
    groupTitle: string;
    message: string;
    ts: number;
  }
  | {
    kind: 'courseStart';
    groupTitle: string;
    workerTag?: string;
    index: number;
    total: number;
    course: Pick<
      CourseInfo,
      'moduleName' | 'syllabusName' | 'activityName' | 'type' | 'progress' | 'activityId'
    >;
    ts: number;
  }
  | {
    kind: 'courseDone';
    groupTitle: string;
    workerTag?: string;
    index: number;
    total: number;
    course: Pick<CourseInfo, 'activityName' | 'type' | 'activityId'>;
    ts: number;
  }
  | {
    kind: 'courseSkip';
    groupTitle: string;
    workerTag?: string;
    index: number;
    total: number;
    reason: string;
    course: Pick<CourseInfo, 'activityName' | 'type' | 'activityId'>;
    ts: number;
  }
  | {
    kind: 'courseError';
    groupTitle: string;
    workerTag?: string;
    index: number;
    total: number;
    message: string;
    course: Pick<CourseInfo, 'activityName' | 'type' | 'activityId'>;
    ts: number;
  };

class IMSRunner {
  private page?: Page;
  private readonly progressListeners = new Set<(e: RunnerProgressEvent) => void>();
  constructor() { }

  private parseProgressValue(progress: CourseInfo['progress'], type?: CourseInfo['type']) {
    // 考试的“完成度”并不可靠（可能需要反复提交到及格线），默认给予更高优先级
    if (type === 'exam') return -1;

    const p = String(progress ?? '').trim().toLowerCase();
    if (!p) return 0;
    if (p === 'full') return 100;
    const m = p.match(/(\d+(?:\.\d+)?)\s*%/);
    if (m) {
      const v = Number(m[1]);
      return Number.isFinite(v) ? v : 0;
    }
    const v = Number(p);
    return Number.isFinite(v) ? v : 0;
  }

  private getLowestNDefault(desiredConcurrency: number, totalCourses: number) {
    // 默认策略：执行所有未完成的课程活动。
    // 可用 _LOWEST_N 覆盖：0 或不填表示全部，正数表示限制数量。
    const raw = process.env._LOWEST_N;
    if (raw == null || String(raw).trim() === '') return totalCourses; // 不填 = 全部
    const n = Math.floor(Number(raw));
    if (!Number.isFinite(n) || n === 0) return totalCourses; // 0 = 全部
    if (n < 0) return totalCourses;
    return n;
  }

  private pickLowestProgressCourses(all: CourseInfo[], desiredConcurrency: number) {
    const n = this.getLowestNDefault(desiredConcurrency, all.length);

    // 保持原始顺序（API 已经按 moduleSort + sort 排序）
    // 只取前 n 个活动，不再按进度重新排序
    // 这样可以保证前置活动先被处理
    const picked = all.slice(0, Math.min(Math.max(n, 1), all.length));
    return { picked, pickedN: picked.length, totalN: all.length, n };
  }

  // 视频类活动类型列表
  private readonly VIDEO_ACTIVITY_TYPES = new Set([
    'online_video',
    'lesson',
    'lesson_replay',
    'slide',
  ]);

  // 检查活动是否是视频类（需要顺序处理的类型）
  private isVideoActivity(type: string): boolean {
    return this.VIDEO_ACTIVITY_TYPES.has(type);
  }

  onProgress(listener: (e: RunnerProgressEvent) => void) {
    this.progressListeners.add(listener);
    return () => this.progressListeners.delete(listener);
  }

  private emitProgress(e: RunnerProgressEvent) {
    for (const l of this.progressListeners) {
      try {
        l(e);
      } catch {
        // ignore listener errors
      }
    }
  }

  private getConcurrency() {
    const raw = Number(process.env._CONCURRENCY ?? 1);
    const n = Number.isFinite(raw) ? Math.floor(raw) : 1;
    // 过高的并发更容易触发风控/限流，也会让 UI 更不稳定；先做一个硬上限。
    // 允许设置为 0：表示“自动并发”（按课程数，最多 6）。
    return Math.min(Math.max(n, 0), 6);
  }

  private resolveConcurrencyForCourses(totalCourses: number) {
    const cfg = this.getConcurrency();
    if (totalCourses <= 0) return 0;
    const desired = cfg === 0 ? Math.min(6, totalCourses) : Math.min(cfg, 6);
    return Math.min(Math.max(desired, 1), totalCourses);
  }

  private isLikelyUiPageByUrl(p: Page) {
    const u = (p.url?.() ?? '').toLowerCase();
    // UI 页面加载的是 index.html；automation 初始为 automation.html，随后会跳到学习平台。
    return u.includes('/index.html') || u.endsWith('index.html');
  }

  private async isUiPage(p: Page) {
    if (this.isLikelyUiPageByUrl(p)) return true;
    const name = await p
      .evaluate(() => window.name)
      .then(String)
      .catch(() => '');
    return name === 'IMS_UI';
  }

  private async collectNonUiPages(context: ReturnType<Page['context']>) {
    const pages = context.pages();
    const result: Page[] = [];
    for (const p of pages) {
      if (await this.isUiPage(p)) continue;
      result.push(p);
    }
    return result;
  }

  private async waitForWorkerPages(
    context: ReturnType<Page['context']>,
    needed: number,
    timeoutMs = 5000,
  ) {
    const start = Date.now();
    let last: Page[] = [];

    while (Date.now() - start < timeoutMs) {
      last = await this.collectNonUiPages(context);
      if (last.length >= needed) return last;
      await new Promise((r) => setTimeout(r, 250));
    }

    return last;
  }

  async restart() {
    if (this.page) await this.start(this.page);
  }

  // 主入口
  async start(page: Page) {
    this.page = page;

    // 补丁：包装 Page.waitForFunction，捕获 TimeoutError 并返回 false，避免单次 wait 导致整个流程失败
    try {
      const proto: any = Object.getPrototypeOf(page);
      if (!proto.__waitForFunctionPatched) {
        const orig = proto.waitForFunction;
        proto.__waitForFunctionPatched = true;
        proto.waitForFunction = async function (fn: any, options?: any, ...args: any[]) {
          try {
            return await orig.apply(this, [fn, options, ...args]);
          } catch (e: any) {
            const msg = String(e?.message ?? '');
            if (msg && msg.includes('Timeout')) {
              console.warn('⚠️ Page.waitForFunction 超时被捕获（已包裹），返回 false：', msg);
              return false; // 以 false 表示未满足条件，但不要抛出异常
            }
            throw e;
          }
        };
        console.log('🔧 已为 Page.waitForFunction 安装超时捕获补丁');
      }
    } catch (e) {
      console.warn('⚠️ 安装 waitForFunction 补丁失败:', (e as any)?.message ?? e);
    }
    // page.on('response', async (response) => {
    //   (await response.body()).
    //   const url = response.url();
    //   if (url.includes('forbidden') || url.includes('banned')) {
    //     console.log(chalk.red('⚠️ 发现风控响应:'), url);
    //     await page.screenshot({ path: 'banned.png' });
    //     exit(1);
    //   }
    // });

    await this.checkRiskStatus(page);
    await this.initSession(page);

    const listItems = await Activity.getActivities();
    const selected = await this.selectCourseGroup(listItems);

    // 自动导航到我的课程页，确保课程列表/SPA 状态已就绪（可解决某些页面跳转后定位问题）
    if (selected.length > 0) {
      try {
        console.log(chalk.gray(`📍 自动导航到我的课程界面: ${Config.urls.userCourses()}`));
        await page.goto(Config.urls.userCourses(), { timeout: 1000 * 60, waitUntil: 'domcontentloaded' });
        await waitForSPALoaded(page);
      } catch (e) {
        console.warn(chalk.yellow('⚠️ 自动导航到我的课程界面失败，继续执行（非致命）'));
      }
    }

    for (const item of selected) {
      console.log(chalk.bold('-'.repeat(60)));
      console.log(chalk.cyan(`开始执行课程组: ${item.title}`));
      await this.processCourseGroup(page, item);
    }

    console.log(chalk.greenBright('🎉 全部课程执行完毕!'));
  }

  // 检查风控状态
  private async checkRiskStatus(page: Page): Promise<boolean> {
    const blockedText =
      '您好，您的账号被检测到异常访问行为，您的账号将被禁止访问教学平台，时限1小时。';

    // 检查页面中是否包含风控提示
    const count = await page.getByText(blockedText, { exact: false }).count();

    if (count > 0) {
      console.error(chalk.bgRed(`⚠️ 检测到风控提示，账号可能已被封禁1小时`));
      await page.screenshot({ path: 'risk_detected.png', fullPage: true });
      return true;
    }

    return false;
  }

  // 初始化会话 cookie
  private async initSession(page: Page) {
    const cs = await page.evaluate(
      async () => await (window as any).cookieStore.getAll(),
    );

    await storeCookies(
      filterCookies(cs, ['session']).map((cookie) => ({
        ...cookie,
        domain: API_BASE_URL.replace(/^https:\/\//, ''),
      })),
    );
  }

  // 用户选择课程组
  private async selectCourseGroup(listItems: ActivityInfo[]) {
    console.log(chalk.bold('\n可选课程组:'));
    console.log(chalk.gray(`0. 全部课程`));

    listItems.forEach((item, i) =>
      console.log(`${i + 1}. ${item.title}  ${item.percent ?? ''}`),
    );

    const parseGroupPercent = (raw: ActivityInfo['percent']) => {
      // completeness 有时是 "81.5"，也可能是 "81.5%" 或 null
      const s = String(raw ?? '').trim();
      if (!s) return NaN;
      const m = s.match(/(\d+(?:\.\d+)?)/);
      if (!m) return NaN;
      const n = Number(m[1]);
      return Number.isFinite(n) ? n : NaN;
    };

    const pickUncompleted = () => {
      const uncompleted = listItems.filter((it) => {
        const p = parseGroupPercent(it.percent);
        // percent 为空/解析失败时不强行过滤；有时接口不返回百分比。
        if (!Number.isFinite(p)) return true;
        return p < 100;
      });
      return uncompleted.length > 0 ? uncompleted : listItems;
    };

    const getGroupLowestN = () => {
      const raw = process.env._GROUP_LOWEST_N ?? process.env._LOWEST_GROUP_N;
      if (raw == null || String(raw).trim() === '') return 3;
      const n = Math.floor(Number(String(raw).trim()));
      return Number.isFinite(n) && n > 0 ? n : 3;
    };

    const pickLowestGroups = () => {
      const candidates = pickUncompleted();
      const n = Math.min(getGroupLowestN(), candidates.length);
      const sorted = [...candidates].sort((a, b) => {
        const pa = parseGroupPercent(a.percent);
        const pb = parseGroupPercent(b.percent);

        // 无法解析时放后面，尽量先跑“明确进度低”的
        const aBad = !Number.isFinite(pa);
        const bBad = !Number.isFinite(pb);
        if (aBad !== bBad) return aBad ? 1 : -1;
        if (Number.isFinite(pa) && Number.isFinite(pb) && pa !== pb) return pa - pb;

        // 同进度时按标题稳定排序
        return a.title.localeCompare(b.title, 'zh-CN');
      });
      return sorted.slice(0, n);
    };

    // 1) 环境变量强制选择（用于 Electron/无控制台环境，或“无法输入序号”的场景）
    const envIndexRaw =
      process.env._GROUP_INDEX ?? process.env._GROUP ?? process.env._COURSE_GROUP;
    if (envIndexRaw != null && String(envIndexRaw).trim() !== '') {
      const n = Number(String(envIndexRaw).trim());
      if (Number.isFinite(n)) {
        const idx = Math.floor(n);
        if (idx === 0) return listItems;
        if (idx >= 1 && idx <= listItems.length) return [listItems[idx - 1]];
        console.warn(
          chalk.yellow(
            `⚠️ _GROUP_INDEX=${envIndexRaw} 超出范围(1..${listItems.length})，将使用默认策略。`,
          ),
        );
      } else {
        console.warn(
          chalk.yellow(`⚠️ _GROUP_INDEX=${envIndexRaw} 不是数字，将使用默认策略。`),
        );
      }
    }

    const envTitleRaw = process.env._GROUP_TITLE;
    if (envTitleRaw && String(envTitleRaw).trim()) {
      const raw = String(envTitleRaw).trim();
      let matcher: (t: string) => boolean;
      if (raw.startsWith('/') && raw.endsWith('/') && raw.length > 2) {
        try {
          const re = new RegExp(raw.slice(1, -1));
          matcher = (t) => re.test(t);
        } catch {
          matcher = (t) => t.includes(raw);
        }
      } else {
        const needle = raw.toLowerCase();
        matcher = (t) => t.toLowerCase().includes(needle);
      }

      const matched = listItems.filter((it) => matcher(it.title));
      if (matched.length > 0) {
        console.log(
          chalk.gray(
            `\n✅ 使用 _GROUP_TITLE 匹配到 ${matched.length} 个课程组：${matched
              .map((x) => x.title)
              .join('、')}`,
          ),
        );
        return matched;
      }
      console.warn(
        chalk.yellow(`⚠️ _GROUP_TITLE 未匹配到课程组：${raw}，将使用默认策略。`),
      );
    }

    // 2) 非交互环境：不要卡住等待输入，直接走默认策略
    const nonInteractive =
      !process.stdin.isTTY ||
      String(process.env._NON_INTERACTIVE ?? '').trim() === '1' ||
      String(process.env._NON_INTERACTIVE ?? '').trim().toLowerCase() === 'true';
    if (nonInteractive) {
      const chosen = pickLowestGroups();
      console.log(
        chalk.gray(
          `\n🧭 当前为非交互模式（无法从控制台读取输入），默认执行进度最低的前 ${chosen.length} 个课程组：${chosen
            .map((x) => `${x.title}(${x.percent ?? '?'})`)
            .join('、')}（可用 _GROUP_LOWEST_N 调整）`,
        ),
      );
      return chosen;
    }

    const timeoutPromise = new Promise<string>((resolve) =>
      setTimeout(() => resolve(''), 20000),
    );
    const userInput = String(
      await Promise.race([
        input('请输入序号选择课程组(20秒后默认只刷未完成课程组): '),
        timeoutPromise,
      ]),
    ).trim();

    // 超时/空输入：默认只跑“未完成的课程组”（避免直接全刷导致窗口/日志很乱）。
    if (!userInput) {
      const chosen = pickLowestGroups();
      if (chosen.length > 0) {
        console.log(
          chalk.gray(
            `\n⏱️ 超时未选择，默认执行进度最低的前 ${chosen.length} 个课程组：${chosen
              .map((x) => `${x.title}(${x.percent ?? '?'})`)
              .join('、')}（可用 _GROUP_LOWEST_N 调整）`,
          ),
        );
        return chosen;
      }

      console.log(chalk.gray('\n⏱️ 超时未选择，未找到“未完成课程组”，回退为全部课程组'));
      return listItems;
    }

    const num = Number(userInput);
    if (isNaN(num)) {
      console.error(chalk.red('❌ 请输入数字'));
      exit(1);
    }

    return num === 0 ? listItems : [listItems[num - 1]];
  }

  // 执行课程组（支持智能串行/并行）
  private async processCourseGroup(page: Page, item: ActivityInfo) {
    try {
      // API 已经只返回未完成的活动，无需额外过滤
      let allCourses = await Search.getUncompletedCourses(page, item);

      // 防止复选框影响 (页面可能没有 checkbox，忽略错误)
      await page.locator('input[type="checkbox"]').setChecked(false).catch(() => void 0);

      const desiredConcurrency = this.resolveConcurrencyForCourses(allCourses.length);
      let { picked: courses, pickedN, totalN } = this.pickLowestProgressCourses(
        allCourses,
        desiredConcurrency,
      );
      const concurrency = this.resolveConcurrencyForCourses(courses.length);

      if (totalN > 0 && pickedN > 0 && pickedN < totalN) {
        console.log(
          chalk.gray(
            `[${item.title}] 默认只执行前 ${pickedN} 个课程（共 ${totalN} 个候选）。` +
            ` 可通过 _LOWEST_N 调整执行数量。`,
          ),
        );
      }

      this.emitProgress({
        kind: 'groupStart',
        groupTitle: item.title,
        totalCourses: courses.length,
        concurrency,
        ts: Date.now(),
      });

      if (courses.length === 0) {
        console.log(chalk.gray(`[${item.title}] 没有需要处理的课程，跳过。`));
        this.emitProgress({
          kind: 'groupEnd',
          groupTitle: item.title,
          ts: Date.now(),
        });
        return;
      }

      // 分离视频类活动和非视频类活动
      const videoActivities = courses.filter((c) => this.isVideoActivity(c.type));
      const nonVideoActivities = courses.filter((c) => !this.isVideoActivity(c.type));

      // 1. 先串行处理视频类活动（因为有前置依赖）
      if (videoActivities.length > 0) {
        console.log(
          chalk.cyan(
            `📹 检测到 ${videoActivities.length} 个视频活动，将按顺序串行处理（避免前置依赖问题）`,
          ),
        );

        let processedCount = 0;
        for (const [i, course] of videoActivities.entries()) {
          await this.processSingleCourse(page, item.title, course, i + 1, videoActivities.length);
          processedCount++;

          // 每处理完一个视频，检查是否需要刷新活动列表以解锁后续活动
          // 只在处理中间视频时刷新，最后一个不需要
          if (i < videoActivities.length - 1 && (i + 1) % 3 === 0) {
            console.log(chalk.gray('🔄 刷新活动列表以检查新解锁的活动...'));
            allCourses = await Search.getUncompletedCourses(page, item);
            // 更新剩余的视频活动列表（可能有新解锁的）
            const remaining = allCourses.filter(
              (c) => this.isVideoActivity(c.type) && !courses.slice(0, i + 1).some((done) => done.activityId === c.activityId),
            );
            if (remaining.length > videoActivities.length - processedCount) {
              console.log(chalk.green(`✅ 发现 ${remaining.length - (videoActivities.length - processedCount)} 个新解锁的视频活动`));
            }
          }
        }
      }

      // 2. 然后处理非视频类活动（可以并发）
      if (nonVideoActivities.length > 0) {
        if (concurrency <= 1 || nonVideoActivities.length <= 1) {
          for (const [i, course] of nonVideoActivities.entries()) {
            await this.processSingleCourse(page, item.title, course, i + 1, nonVideoActivities.length);
          }
        } else {
          console.log(
            chalk.yellow(
              `⚡ 非视频活动并发处理：${Math.min(concurrency, nonVideoActivities.length)} 个窗口`,
            ),
          );
          await this.processCourseGroupConcurrently(page, item, nonVideoActivities, concurrency);
        }
      }

      await this.goBackToCourseList(page);

      this.emitProgress({
        kind: 'groupEnd',
        groupTitle: item.title,
        ts: Date.now(),
      });
    } catch (e: any) {
      console.error(
        chalk.red(`[${item.title}] 课程组执行异常: ${e.message ?? e}`),
      );

      this.emitProgress({
        kind: 'groupError',
        groupTitle: item.title,
        message: String(e?.message ?? e),
        ts: Date.now(),
      });
    }
  }

  private async openCourseGroupListPage(page: Page, item: ActivityInfo) {
    await page.goto(`${Config.urls.course()}/${item.id}/ng#/`, {
      timeout: 1000 * 60,
      waitUntil: 'domcontentloaded',
    });
    await page.waitForURL(RegExp(`^${Config.urls.course()}.*`), {
      timeout: 1000 * 60,
      waitUntil: 'domcontentloaded',
    });

    await waitForSPALoaded(page);

    // 尽量展开全部，避免 locator 找不到（按钮显示“展开”表示当前未展开）
    const expandBtn = page.getByText(/全部(?:收起|展开)/);
    const expandText = ((await expandBtn.textContent().catch(() => '')) ?? '').trim();
    if (expandText.includes('展开')) {
      await expandBtn.click().catch(() => void 0);
      await page.waitForLoadState('domcontentloaded');
      await waitForSPALoaded(page);
    }

    // 关闭过滤/复选框，避免列表动态变化导致定位错乱
    await page.locator('input[type="checkbox"]').setChecked(false).catch(() => void 0);
    await waitForSPALoaded(page);
  }

  private async processCourseGroupConcurrently(
    mainPage: Page,
    item: ActivityInfo,
    courses: CourseInfo[],
    concurrency: number,
  ) {
    const context = mainPage.context();
    const workerCount = Math.min(concurrency, courses.length);

    // Electron + CDP 场景下，Target.createTarget 可能不支持，context.newPage() 会直接报错。
    // 所以这里优先复用已有窗口对应的 pages。
    // 之前只按 window.name==='IMS_AUTOMATION' 过滤，偶发会因为窗口未就绪导致 evaluate 失败，结果只拿到 1 个 worker。
    // 这里改为：排除 UI 页面后尽可能收集所有非 UI pages，并短暂轮询等待窗口就绪。
    let nonUiPages = await this.waitForWorkerPages(context, workerCount, 5000);

    // 保证 mainPage 在列表最前（方便 W1 固定为主窗口，日志/行为更稳定）
    nonUiPages = [mainPage, ...nonUiPages.filter((p) => p !== mainPage)];
    const workerPages = nonUiPages.slice(0, workerCount);

    // 尝试补足（在非 Electron/非受限 CDP 的环境里可用）；失败则降级。
    while (workerPages.length < workerCount) {
      try {
        workerPages.push(await context.newPage());
      } catch {
        break;
      }
    }

    if (workerPages.length <= 1) {
      console.log(
        chalk.yellow(
          '⚠️ 当前运行环境不支持创建额外页面，已自动降级为串行。' +
          '（Electron CDP 下需要预创建多个窗口或将 _CONCURRENCY 设为 1）',
        ),
      );
      for (const [i, course] of courses.entries()) {
        await this.processSingleCourse(
          mainPage,
          item.title,
          course,
          i + 1,
          courses.length,
        );
      }
      return;
    }

    console.log(
      chalk.gray(
        `可用窗口(Page)数量：${context.pages().length}，将使用 ${workerPages.length}/${workerCount} 个 worker 窗口。`,
      ),
    );

    await Promise.all(
      workerPages.map(async (p, i) => {
        // 给每个 worker 一个轻微错峰，减少同时请求导致的风控概率
        await new Promise((r) => setTimeout(r, i * 400));
        await this.openCourseGroupListPage(p, item);
      }),
    );

    let next = 0;
    await Promise.all(
      workerPages.map(async (p, wi) => {
        const tag = `W${wi + 1}`;
        while (true) {
          const idx = next++;
          if (idx >= courses.length) return;
          const course = courses[idx];

          // 并发模式下，不保证按序输出；用 tag 帮助区分日志
          await this.processSingleCourse(
            p,
            item.title,
            course,
            idx + 1,
            courses.length,
            tag,
          );
        }
      }),
    );
  }

  // 执行单个课程
  private async processSingleCourse(
    page: Page,
    groupTitle: string,
    course: CourseInfo,
    index: number,
    total: number,
    workerTag?: string,
  ) {
    const prefix = workerTag ? `[${workerTag}] ` : '';

    this.emitProgress({
      kind: 'courseStart',
      groupTitle,
      workerTag,
      index,
      total,
      course: {
        moduleName: course.moduleName,
        syllabusName: course.syllabusName,
        activityName: course.activityName,
        type: course.type,
        progress: course.progress,
        activityId: course.activityId,
      },
      ts: Date.now(),
    });
    console.log(
      chalk.bgBlueBright(
        format(
          `${prefix}%s %s %s %s : %d/%d`,
          course.moduleName,
          course.syllabusName ?? '',
          course.activityName,
          course.progress,
          index,
          total,
        ),
      ),
    );

    const processor = Processor.getProcessor(course.type);
    if (!processor) {
      console.warn(
        '⚠️ 不支持的课程类型:',
        Processor.getCourseType(course.type),
      );

      this.emitProgress({
        kind: 'courseSkip',
        groupTitle,
        workerTag,
        index,
        total,
        reason: '不支持的课程类型',
        course: {
          activityName: course.activityName,
          type: course.type,
          activityId: course.activityId,
        },
        ts: Date.now(),
      });
      return;
    }

    if (processor.condition && !(await processor.condition(course))) {
      this.emitProgress({
        kind: 'courseSkip',
        groupTitle,
        workerTag,
        index,
        total,
        reason: 'condition=false',
        course: {
          activityName: course.activityName,
          type: course.type,
          activityId: course.activityId,
        },
        ts: Date.now(),
      });
      return;
    }

    // 直接通过 URL 导航到活动页面，避免 DOM 点击不稳定
    const activityUrl = this.buildActivityUrl(course);
    console.log(`${prefix}📍 导航到活动: ${activityUrl}`);

    try {
      await page.goto(activityUrl, {
        timeout: 60000,
        waitUntil: 'domcontentloaded',
      });
    } catch (e) {
      console.warn(`${prefix}⚠️ 导航失败:`, e);
      this.emitProgress({
        kind: 'courseSkip',
        groupTitle,
        workerTag,
        index,
        total,
        reason: '导航失败',
        course: {
          activityName: course.activityName,
          type: course.type,
          activityId: course.activityId,
        },
        ts: Date.now(),
      });
      return;
    }

    await errorWithRetry(`处理课程: ${course.activityName}`, 3)
      .retry(async () => {
        await page.reload({ timeout: 60000 });
      })
      .failed((e) => {
        console.log(`执行出错: ${e}`);

        this.emitProgress({
          kind: 'courseError',
          groupTitle,
          workerTag,
          index,
          total,
          message: String(e),
          course: {
            activityName: course.activityName,
            type: course.type,
            activityId: course.activityId,
          },
          ts: Date.now(),
        });
      })
      .run(async () => {
        await waitForSPALoaded(page);
        await processor.exec(page);
      });

    await this.goBackToCourseList(page);

    this.emitProgress({
      kind: 'courseDone',
      groupTitle,
      workerTag,
      index,
      total,
      course: {
        activityName: course.activityName,
        type: course.type,
        activityId: course.activityId,
      },
      ts: Date.now(),
    });
  }

  // 构建活动 URL（直接导航，避免 DOM 依赖）
  private buildActivityUrl(course: CourseInfo): string {
    const baseUrl = Config.urls.course();
    // 考试使用 full-screen#/exam/{id} 格式
    if (course.type === 'exam') {
      return `${baseUrl}/${course.courseId}/learning-activity/full-screen#/exam/${course.activityId}`;
    }
    // 其他学习活动使用 learning-activity#/{id} 格式
    return `${baseUrl}/${course.courseId}/learning-activity#/${course.activityId}`;
  }

  // 课程定位（保留以兼容其他可能的用途）
  private getCourseLocator(page: Page, course: CourseInfo) {
    let loc = page.locator(`#${course.moduleId}`);
    if (course.syllabusId) loc = loc.locator(`#${course.syllabusId}`);
    return loc
      .locator(`#learning-activity-${course.activityId}`)
      .getByText(course.activityName, { exact: true });
  }

  // 懒加载/虚拟滚动：滚动课程列表以让目标 activity 进入 DOM
  private async ensureCourseVisibleInList(page: Page, course: CourseInfo) {
    const activitySel = `#learning-activity-${course.activityId}`;

    // 先回到顶部，避免在底部/中部导致滚动策略无效
    await page.evaluate(() => window.scrollTo(0, 0)).catch(() => void 0);

    // 越靠后的课程越可能不在首屏；先粗略滚动到接近底部
    const maxSteps = 10;
    for (let step = 0; step < maxSteps; step++) {
      if ((await page.locator(activitySel).count()) > 0) return;

      await page
        .evaluate(() => {
          const dy = Math.max(window.innerHeight * 0.9, 900);
          window.scrollBy(0, dy);
        })
        .catch(() => void 0);

      // 给 SPA/渲染一点时间
      await page.waitForTimeout(180).catch(() => void 0);

      // 每隔几步尝试等待 SPA 稳定一次（避免一直在加载中）
      if (step === 2 || step === 6) {
        await waitForSPALoaded(page).catch(() => void 0);
      }
    }
  }

  // 检查锁定/未开始
  private async isLockedOrUpcoming(t: Locator) {
    if ((await t.getAttribute('class'))?.includes('locked')) {
      console.log('🔒 课程锁定，跳过');
      return true;
    }
    if (await t.locator('xpath=../*[contains(@class, "upcoming")]').count()) {
      console.log('⏳ 课程未开始，跳过');
      return true;
    }
    return false;
  }

  // 返回上一级页面（URL 直接导航模式下，此方法可选）
  private async goBackToCourseList(_page: Page) {
    // 使用 URL 直接导航后，不需要返回课程列表
    // 保留此方法以兼容现有调用
  }
}

export const ims = {
  login(browser: Browser, config: LoginConfig) {
    const runner = new IMSRunner();
    return {
      onProgress(listener: (e: RunnerProgressEvent) => void) {
        return runner.onProgress(listener);
      },
      async start() {
        return await runner
          .start(await login(browser, config))
          .catch(() => runner);
      },
    };
  },
};

export type { RunnerProgressEvent };
