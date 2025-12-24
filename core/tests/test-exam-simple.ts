/**
 * 简化版考试测试脚本
 * 用法: npx tsx ./tests/test-exam-simple.ts
 */
import 'dotenv/config';
import playwright from 'playwright';
const { chromium } = playwright;
import AIModel from '../src/ai/AIModel.js';
import Config from '../src/config.js';
import { restoreCookies, filterCookies, storeCookies } from '../src/login.js';
import ExamProc from '../src/course/processor/ExamProc.js';
import { CourseInfo } from '../src/course/search.js';

async function main() {
  console.log('=== 考试流程测试 ===\n');

  // 1. 初始化 AI
  console.log('[1] 初始化 AI...');
  const ai = await AIModel.init(true);
  if (!ai) {
    console.error('❌ AI 初始化失败，请检查 .env 配置');
    process.exit(1);
  }
  console.log('✅ AI 初始化成功\n');

  // 2. 启动浏览器
  console.log('[2] 启动浏览器...');
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();

  // 恢复 cookies
  const cookies = await restoreCookies();
  if (cookies.length > 0) {
    console.log('恢复已保存的 cookies...');
    await context.addCookies(filterCookies(cookies, ['session'])).catch(e => {
      console.warn('Cookie 恢复失败:', e);
    });
  }

  const page = await context.newPage();

  // 3. 直接访问 LMS 主页检查登录状态
  console.log('[3] 检查登录状态...');
  await page.goto('https://lms.ouchn.cn/user/index#/', { timeout: 60000 });

  // 如果被重定向到登录页，需要手动登录
  const currentUrl = page.url();
  console.log('当前 URL:', currentUrl);

  if (currentUrl.includes('iam.pt.ouchn.cn') || currentUrl.includes('login')) {
    console.log('需要登录，正在填写表单...');

    // 等待并勾选同意
    await page.locator('#agreeCheckBox').first().setChecked(true).catch(() => { });

    const { account, password } = Config.user;
    if (account && password) {
      await page.getByPlaceholder('请输入登录名').fill(account);
      await page.getByPlaceholder('请输入登录密码').fill(password);
      await page.getByRole('button', { name: /^\s*登\s*录\s*$/ }).click();
    }

    console.log('等待登录完成（如有验证码请手动处理）...');
    // 等待跳转到 LMS
    await page.waitForURL(/lms\.ouchn\.cn/, { timeout: 300000 }); // 5分钟超时

    // 保存 cookies
    const newCookies = await context.cookies();
    await storeCookies(newCookies);
    console.log('Cookies 已保存');
  }

  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => { });
  console.log('✅ 登录成功，当前 URL:', page.url(), '\n');

  // 3. 测试考试
  // 使用已知的考试 ID（专题一：17 题）
  const testExamInfo: CourseInfo = {
    moduleId: 'test-module',
    moduleName: '专题一 毛泽东思想及其历史地位',
    syllabusId: null,
    syllabusName: null,
    activityId: 30003642924, // 专题测验
    activityName: '专题测验',
    type: 'exam',
    progress: 'part',
  };

  console.log('[4] 准备考试处理器...');
  console.log('考试 ID:', testExamInfo.activityId);
  console.log('考试名称:', testExamInfo.activityName);

  const examProc = new ExamProc();

  console.log('\n[5] 检查考试条件...');
  const canRun = await examProc.condition(testExamInfo);

  if (!canRun) {
    console.log('❌ 考试条件不满足（可能已满分或不支持题型）');
    await browser.close();
    return;
  }

  console.log('✅ 条件满足，开始答题...\n');

  console.log('[6] 执行考试...');
  await examProc.exec(page);

  console.log('\n=== 测试完成 ===');

  // 保持浏览器打开以便查看结果
  console.log('按 Ctrl+C 关闭浏览器');
}

main().catch(console.error);
