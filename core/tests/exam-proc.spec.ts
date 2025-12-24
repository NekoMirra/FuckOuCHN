import test, { expect } from '@playwright/test';
import AIModel from '../src/ai/AIModel.js';
import ExamProc from '../src/course/processor/ExamProc.js';

test.skip(
  process.env._RUN_E2E !== '1',
  '需要真实环境（登录态/活动ID/AI/已安装 Playwright 浏览器），设置 _RUN_E2E=1 才运行',
);

test('测试考试答题', async ({ page }) => {
  const aiModel = AIModel.init(true);
  expect(await aiModel, '连接失败').not.toBeNull();
  const exam = new ExamProc();
  await exam.condition({
    courseId: 0, // 替换为实际的课程 ID
    moduleId: '??',
    moduleName: '??',
    syllabusId: null,
    syllabusName: null,
    activityId: 60000502885,
    activityName: '??',
    type: 'exam',
    progress: 'part',
  });
  await exam.exec(page);
});
