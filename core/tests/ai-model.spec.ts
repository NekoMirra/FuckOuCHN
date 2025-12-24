import test, { expect } from '@playwright/test';
import AIModel from '../src/ai/AIModel.js';

const hasAIEnv = !!(process.env._API && process.env._KEY && process.env._MODEL);

// test('测试AI连通', async () => {
//   const aiModel = AIModel.init(true);
//   expect(await aiModel, '连接失败').not.toBeNull();
//   await AIModel.instance!.getResponse('你是谁');
//   await AIModel.instance!.getResponse('哈喽!');
// });
const letters = (i: number) => ['A', 'B', 'C', 'D'][i];

test('单项选择题测试', async () => {
  test.skip(!hasAIEnv, '未配置 AI 环境变量（_API/_KEY/_MODEL），跳过在线 AI 测试');
  expect(await AIModel.init(true)).not.toBeNull();
  // 不同模型可能产生不同结果
  // 下面为星火大模型测试结果

  // 正确率大概50%,有点低...但是勉强能用
  // 比如下面的AI回答D, 正确答案为A, 当我们帮助AI排除D, AI会选择A为答案
  let description = '（  ）是社会主义先进文化的集中体现。';
  let options = [
    '社会主义核心价值观',
    '儒家思想',
    '革命文化',
    '中华优秀传统文化',
  ];

  let r = await AIModel.instance!.getResponse(
    'single_selection',
    description,
    options,
  );

  console.log(letters(r));

  // AI回答正确为C
  description = '文化自信的显著特点是（  ）';
  options = [
    '实现文化传承',
    '坚守民族立场',
    '坚守中华文明立场',
    '人类共同价值',
  ];

  r = await AIModel.instance!.getResponse(
    'single_selection',
    description,
    options,
  );

  console.log(letters(r));
});

test('判断题测试', async () => {
  test.skip(!hasAIEnv, '未配置 AI 环境变量（_API/_KEY/_MODEL），跳过在线 AI 测试');
  expect(await AIModel.init(true)).not.toBeNull();

  // AI回答A,正确答案为B
  let description = '文化自信是历史自信、文明自信生成的基础。';
  let options = ['正确', '错误'];

  let r = await AIModel.instance!.getResponse(
    'true_or_false',
    description,
    options,
  );

  console.log(letters(r));

  // AI回答A, 正确答案为A
  description =
    '精神上的独立自主是坚定文化自信的思想基础，也是文化发展的重要条件。';
  options = ['正确', '错误'];

  r = await AIModel.instance!.getResponse(
    'true_or_false',
    description,
    options,
  );

  console.log(letters(r));
});
