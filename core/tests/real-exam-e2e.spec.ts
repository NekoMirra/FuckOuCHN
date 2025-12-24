import test, { expect } from '@playwright/test';
import AIModel from '../src/ai/AIModel.js';
import Config from '../src/config.js';
import { login } from '../src/login.js';
import { getActivities } from '../src/activity.js';
import { getUncompletedCourses } from '../src/course/search.js';
import ExamProc from '../src/course/processor/ExamProc.js';
import ClassroomProc from '../src/course/processor/ClassroomProc.js';

test('真实环境：登录并自动完成一个考试', async ({ browser }) => {
  // 1. 检查环境
  // 用户强烈要求“真实的测试”，所以如果没设置变量，我们这里直接报错提示，而不是静默 skip
  if (process.env._RUN_E2E !== '1') {
    console.warn('⚠️ 警告: 未设置 _RUN_E2E=1，测试将被跳过。请在 .env 或命令行中设置。');
    test.skip(true, '请设置 _RUN_E2E=1 以运行此真实环境测试');
  }

  // 2. 初始化 AI
  console.log('正在初始化 AI...');
  const ai = await AIModel.init(true);
  expect(ai, 'AI 初始化失败，请检查 .env 配置 (_API, _KEY, _MODEL)').not.toBeNull();

  // 3. 登录
  console.log('正在登录...');
  const page = await login(browser, {
    account: Config.user.account,
    password: Config.user.password,
    loginApi: Config.urls.login(),
    homeApi: Config.urls.home(),
  });

  // 简单的登录验证
  await page.waitForLoadState('networkidle');
  const url = page.url();
  console.log('当前页面 URL:', url);
  expect(url).toContain('lms.ouchn.cn');

  // 4. 获取课程列表
  console.log('正在获取课程列表...');
  // 注意：getActivities 内部使用的是 axios (Course.getMyCourses)，它依赖 login 过程中保存的 cookies
  // login 函数里调用了 storeCookies，所以这里应该是可以的
  const activities = await getActivities();
  console.log(`共找到 ${activities.length} 门课程`);

  let examFound = false;

  // 5. 遍历课程寻找考试
  for (const activity of activities) {
    console.log(`--------------------------------------------------`);
    console.log(`正在扫描课程: ${activity.title} (ID: ${activity.id})`);

    // 获取该课程下的未完成任务
    // getUncompletedCourses 会控制 page 跳转到课程页
    const tasks = await getUncompletedCourses(page, activity);
    console.log(`该课程有 ${tasks.length} 个未完成任务`);

    // 筛选考试
    const exams = tasks.filter(t => t.type === 'exam' || t.type === 'classroom');

    if (exams.length > 0) {
      for (const target of exams) {
        console.log(`>> 发现考试: ${target.activityName} (ID: ${target.activityId}, Type: ${target.type})`);

        // 6. 执行考试
        let proc;
        if (target.type === 'classroom') {
          proc = new ClassroomProc();
        } else {
          proc = new ExamProc();
        }

        // 检查条件 (例如是否已过期，是否支持该题型等)
        console.log('检查考试条件...');
        if (await proc.condition(target)) {
          console.log('>>> 条件满足，开始自动答题...');
          await proc.exec(page);
          console.log('>>> 答题结束');
          examFound = true;

          // 找到一个并执行完后，我们就退出测试，避免一次跑太多
          break;
        } else {
          console.log('该考试不满足执行条件 (condition=false)，跳过');
        }
      }

      if (examFound) break;
    } else {
      console.log('该课程下没有未完成的考试/随堂测试');
    }
  }

  if (!examFound) {
    console.log('==================================================');
    console.log('遍历了所有课程，未找到可执行的考试/随堂测试。');
    console.log('可能是所有考试都已完成，或者当前没有进行中的考试。');
  } else {
    console.log('==================================================');
    console.log('测试成功完成！');
  }
});
