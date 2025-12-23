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

    for (const item of selected) {
      console.log(chalk.bold('-'.repeat(60)));
      console.log(chalk.cyan(`开始执行课程组: ${item.title}`));
      if (!item.percent) continue;
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
      const uncompleted = listItems.filter((it) => {
        const p = String(it.percent ?? '').trim();
        // percent 为空时不强行过滤；有时接口不返回百分比。
        if (!p) return true;
        return !/100\s*%/.test(p);
      });
      if (uncompleted.length > 0) {
        console.log(
          chalk.gray(
            `\n⏱️ 超时未选择，默认执行未完成课程组：${uncompleted
              .map((x) => x.title)
              .join('、')}`,
          ),
        );
        return uncompleted;
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

  // 执行课程组
  private async processCourseGroup(page: Page, item: ActivityInfo) {
    try {
      const courses = (await Search.getUncompletedCourses(page, item)).filter(
        (course) => course.progress != 'full' || course.type == 'exam',
      );

      // 防止复选框影响
      await page.locator('input[type="checkbox"]').setChecked(false);

      const concurrency = this.resolveConcurrencyForCourses(courses.length);

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

      if (concurrency <= 1 || courses.length <= 1) {
        for (const [i, course] of courses.entries()) {
          await this.processSingleCourse(page, item.title, course, i + 1, courses.length);
        }
      } else {
        console.log(
          chalk.yellow(
            `⚡ 并发模式已启用：${concurrency} 个窗口并行处理（_CONCURRENCY=${process.env._CONCURRENCY ?? '1'}）`,
          ),
        );
        await this.processCourseGroupConcurrently(page, item, courses, concurrency);
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

    let t = this.getCourseLocator(page, course);

    // 并发/新页面场景：课程列表可能使用虚拟滚动/懒加载，未滚动时目标 activity 尚未渲染进 DOM。
    // 因此先尝试滚动加载后再找，避免“误跳过”。
    if ((await t.count()) === 0) {
      await this.ensureCourseVisibleInList(page, course);
      t = this.getCourseLocator(page, course);
    }

    if ((await t.count()) === 0) {
      console.warn(
        `${prefix}⚠️ 未找到课程条目（可能：已完成/列表变化/懒加载未渲染），跳过:`,
        course.activityName,
      );

      this.emitProgress({
        kind: 'courseSkip',
        groupTitle,
        workerTag,
        index,
        total,
        reason: '未找到课程条目',
        course: {
          activityName: course.activityName,
          type: course.type,
          activityId: course.activityId,
        },
        ts: Date.now(),
      });
      return;
    }

    if (await this.isLockedOrUpcoming(t)) return;

    try {
      await t.scrollIntoViewIfNeeded().catch(() => void 0);
      await t.click();
    } catch {
      this.emitProgress({
        kind: 'courseSkip',
        groupTitle,
        workerTag,
        index,
        total,
        reason: '点击失败',
        course: {
          activityName: course.activityName,
          type: course.type,
          activityId: course.activityId,
        },
        ts: Date.now(),
      });
      return;
    }

    await page.waitForURL(RegExp(`^${Config.urls.course()}.*`), {
      timeout: 30000,
      waitUntil: 'domcontentloaded',
    });

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

  // 课程定位
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

  // 返回上一级页面
  private async goBackToCourseList(page: Page) {
    await page.goBack({ waitUntil: 'domcontentloaded', timeout: 0 });
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 5000 });
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
