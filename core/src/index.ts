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
import { attachDebugNetwork, errorWithRetry, input, waitForSPALoaded } from './utils.js';
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
    // 默认策略：
    // - 如果开启了视频刷课（enableVideo），默认处理全部未完成课程
    // - 否则只执行"进度最低的前 N 个课程"
    // N 默认为并发度（自动并发时通常是 6 / 课程数）。可用 _LOWEST_N 覆盖。
    const raw = process.env._LOWEST_N;
    if (raw != null && String(raw).trim() !== '') {
      const n = Math.floor(Number(raw));
      if (Number.isFinite(n) && n > 0) return n;
      // _LOWEST_N=0 表示处理全部
      if (n === 0) return totalCourses;
    }
    // 开启视频刷课时，默认处理全部未完成课程
    if (Config.features.enableVideo) {
      return totalCourses;
    }
    return desiredConcurrency;
  }

  private pickLowestProgressCourses(all: CourseInfo[], desiredConcurrency: number) {
    const n = this.getLowestNDefault(desiredConcurrency, all.length);
    const sorted = [...all].sort((a, b) => {
      const pa = this.parseProgressValue(a.progress, a.type);
      const pb = this.parseProgressValue(b.progress, b.type);
      if (pa !== pb) return pa - pb;
      // 同进度时按名称稳定排序，减少每次运行顺序抖动
      const an = `${a.moduleName} ${a.syllabusName ?? ''} ${a.activityName}`;
      const bn = `${b.moduleName} ${b.syllabusName ?? ''} ${b.activityName}`;
      return an.localeCompare(bn, 'zh-CN');
    });

    const picked = sorted.slice(0, Math.min(Math.max(n, 1), sorted.length));
    return { picked, pickedN: picked.length, totalN: all.length, n };
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
    attachDebugNetwork(page);
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

  // 执行课程组
  private async processCourseGroup(page: Page, item: ActivityInfo) {
    try {
      const rawCourses = await Search.getUncompletedCourses(page, item);

      // exam-only：只处理考试类活动，避免为了“只答题”仍拉取/遍历其他栏目。
      // 同时过滤掉未注册的处理器（例如被功能开关关闭），避免后续打印“⚠️ 不支持的课程类型”。
      const examOnly = Config.features.enableExam && !Config.features.enableVideo;
      const allCourses = rawCourses
        .filter((course) => (examOnly ? course.type === 'exam' || course.type === 'classroom' : true))
        .filter((course) => {
          // 原逻辑：完成(full)的内容默认跳过，但考试仍可能需要进入以拿到分数/确认提交次数。
          if (!examOnly && course.progress === 'full' && course.type !== 'exam') return false;
          return true;
        })
        .filter((course) => !!Processor.getProcessor(course.type));

      const desiredConcurrency = this.resolveConcurrencyForCourses(allCourses.length);

      // exam-only：KISS
      // - 不要只取“最低 N 个”，否则会把真正的形考任务漏掉（例如先被一堆 submit_limit=0 的案例练习占坑）。
      // - 直接处理全部考试条目，并用名称做一个简单优先级：形考任务 > 专题测验 > 其他 > 案例练习。
      const courses = examOnly
        ? [...allCourses].sort((a, b) => {
          const weight = (name: string) => {
            const s = String(name ?? '');
            if (s.includes('形考任务')) return 0;
            if (s.includes('专题测验')) return 1;
            if (s.includes('案例练习')) return 9;
            return 5;
          };
          const wa = weight(a.activityName);
          const wb = weight(b.activityName);
          if (wa !== wb) return wa - wb;
          const pa = this.parseProgressValue(a.progress, a.type);
          const pb = this.parseProgressValue(b.progress, b.type);
          if (pa !== pb) return pa - pb;
          return a.activityName.localeCompare(b.activityName, 'zh-CN');
        })
        : this.pickLowestProgressCourses(allCourses, desiredConcurrency).picked;

      const pickedN = courses.length;
      const totalN = allCourses.length;
      const concurrency = this.resolveConcurrencyForCourses(courses.length);

      if (!examOnly && totalN > 0 && pickedN > 0 && pickedN < totalN) {
        console.log(
          chalk.gray(
            `[${item.title}] 将执行 ${pickedN} 个课程（共 ${totalN} 个候选）。` +
            ` 可通过 _LOWEST_N 调整执行数量（设为 0 表示全部）。`,
          ),
        );
      } else if (!examOnly && totalN > 0) {
        console.log(
          chalk.gray(
            `[${item.title}] 将执行全部 ${totalN} 个未完成课程。`,
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

    // 不再需要提前打开课程列表页，每个活动直接通过 URL 导航

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
      console.warn('⚠️ 未找到处理器(可能已被功能开关关闭):', Processor.getCourseType(course.type));

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

    const examOnly = Config.features.enableExam && !Config.features.enableVideo;
    const canExecWithoutOpen = examOnly && (course.type === 'exam' || course.type === 'classroom');

    // 直接通过 URL 导航到活动页面（废弃了 DOM 点击方式）
    if (!canExecWithoutOpen) {
      const activityUrl = this.getActivityUrl(course);
      console.log(chalk.gray(`${prefix}导航到活动页面...`));

      try {
        await page.goto(activityUrl, {
          timeout: 30000,
          waitUntil: 'domcontentloaded',
        });
        await waitForSPALoaded(page);
      } catch (e) {
        console.warn(`${prefix}⚠️ 无法打开活动页面，跳过: ${course.activityName}`);
        this.emitProgress({
          kind: 'courseSkip',
          groupTitle,
          workerTag,
          index,
          total,
          reason: '无法打开活动页面',
          course: {
            activityName: course.activityName,
            type: course.type,
            activityId: course.activityId,
          },
          ts: Date.now(),
        });
        return;
      }
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
        if (!canExecWithoutOpen) await waitForSPALoaded(page);
        await processor.exec(page);
      });

    if (!canExecWithoutOpen) {
      await this.goBackToCourseList(page);
    }

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

  /**
   * 生成活动页面的直接访问 URL
   * 格式: /course/{courseId}/learning-activity/full-screen#/{activityId}
   */
  private getActivityUrl(course: CourseInfo): string {
    return `${Config.urls.course()}/${course.courseId}/learning-activity/full-screen#/${course.activityId}`;
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
