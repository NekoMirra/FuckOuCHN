/**
 * 完整课程处理测试脚本
 * 支持测试考试、随堂测试、论坛、资料等多种类型
 * 用法: tsx tests/test-full-course.ts
 */
import 'dotenv/config';
import playwright from 'playwright';
const { chromium } = playwright;
import AIModel from '../src/ai/AIModel.js';
import Config from '../src/config.js';
import { restoreCookies, filterCookies, storeCookies } from '../src/login.js';
import ExamProc from '../src/course/processor/ExamProc.js';
import ClassroomProc from '../src/course/processor/ClassroomProc.js';
import { CourseInfo, CourseType } from '../src/course/search.js';
import Exam from '../src/api/Exam.js';
import course from '../src/api/course.js';

// 测试活动列表 - 可以根据需要添加更多
const testActivities: CourseInfo[] = [
  // 专题一测验 (17题，已验证满分)
  {
    courseId: 30001870501, // 替换为实际的课程 ID
    moduleId: 'test-module',
    moduleName: '专题一',
    moduleSort: 0,
    syllabusId: null,
    syllabusName: null,
    activityId: 30003642924,
    activityName: '专题测验',
    type: 'exam',
    progress: 'part',
    sort: 0,
  },
  // 可以添加更多测试活动...
];

async function main() {
  console.log('=== 完整课程处理测试 ===\n');

  // 1. 初始化 AI
  console.log('[1] 初始化 AI...');
  const ai = await AIModel.init(true);
  if (!ai) {
    console.error('❌ AI 初始化失败');
    process.exit(1);
  }
  console.log('✅ AI 初始化成功 (QPS:', ai.qps, ')\n');

  // 2. 启动浏览器
  console.log('[2] 启动浏览器...');
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();

  // 恢复 cookies
  const cookies = await restoreCookies();
  if (cookies.length > 0) {
    await context.addCookies(filterCookies(cookies, ['session'])).catch(() => { });
  }

  const page = await context.newPage();

  // 3. 检查登录
  console.log('[3] 检查登录状态...');
  await page.goto('https://lms.ouchn.cn/user/index#/', { timeout: 60000 });

  if (page.url().includes('iam.pt.ouchn.cn')) {
    console.log('需要登录...');
    await page.locator('#agreeCheckBox').first().setChecked(true).catch(() => { });
    const { account, password } = Config.user;
    if (account && password) {
      await page.getByPlaceholder('请输入登录名').fill(account);
      await page.getByPlaceholder('请输入登录密码').fill(password);
      await page.getByRole('button', { name: /^\s*登\s*录\s*$/ }).click();
    }
    await page.waitForURL(/lms\.ouchn\.cn/, { timeout: 300000 });
    const newCookies = await context.cookies();
    await storeCookies(newCookies);
  }
  console.log('✅ 登录成功\n');

  // 4. 测试各个活动
  console.log('[4] 测试活动列表...\n');

  for (const activity of testActivities) {
    console.log(`\n${'='.repeat(50)}`);
    console.log(`📋 活动: ${activity.activityName}`);
    console.log(`   类型: ${activity.type}`);
    console.log(`   ID: ${activity.activityId}`);
    console.log('='.repeat(50));

    try {
      if (activity.type === 'exam') {
        await testExam(page, activity);
      } else if (activity.type === 'classroom') {
        await testClassroom(page, activity);
      } else {
        console.log(`⏭️ 暂不支持测试类型: ${activity.type}`);
      }
    } catch (e) {
      console.error(`❌ 测试失败:`, e);
    }
  }

  console.log('\n=== 所有测试完成 ===');
  console.log('按 Ctrl+C 关闭浏览器');
}

async function testExam(page: playwright.Page, info: CourseInfo) {
  const proc = new ExamProc();

  console.log('\n检查考试条件...');
  const canRun = await proc.condition(info);

  if (!canRun) {
    console.log('⏭️ 考试条件不满足（可能已满分或不支持）');
    return;
  }

  console.log('✅ 条件满足，执行考试...');
  await proc.exec(page);
  console.log('✅ 考试完成');
}

async function testClassroom(page: playwright.Page, info: CourseInfo) {
  const proc = new ClassroomProc();

  console.log('\n检查随堂测试条件...');
  const canRun = await proc.condition(info);

  if (!canRun) {
    console.log('⏭️ 随堂测试条件不满足');
    return;
  }

  console.log('✅ 条件满足，执行随堂测试...');
  await proc.exec(page);
  console.log('✅ 随堂测试完成');
}

// 辅助函数：查找课程中的所有活动
async function findCourseActivities(courseId: number): Promise<CourseInfo[]> {
  // 这里可以调用 API 获取课程活动列表
  // 目前返回空数组，需要时可以扩展
  return [];
}

main().catch(console.error);
