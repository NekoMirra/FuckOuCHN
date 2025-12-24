import test from '@playwright/test';
import AIModel, { Num, num2Letter } from '../../src/ai/AIModel.js';
import { OptionId, SubjectType } from '../../src/api/Exam.js';
import { Subject } from '../../src/course/exam/BaseSubjectResolver';
import { createResolver } from '../../src/course/exam/resolver.js';

test('多选题决策', async () => {
  test.skip(
    !(process.env._API && process.env._KEY && process.env._MODEL),
    '未配置 AI 环境变量（_API/_KEY/_MODEL），跳过在线 AI 测试',
  );

  const question = {
    description: '下列关于通用计算机的描述中，正确的是  ______  。',
    difficulty_level: 'medium',
    id: 60020717611,
    last_updated_at: '2024-08-07T11:20:17Z',
    options: [
      {
        content: '用于解决不同类型问题而设计',
        id: 60055686435,
        sort: 0,
        type: 'text',
      },
      {
        content: '用途广泛',
        id: 60055686436,
        sort: 1,
        type: 'text',
      },
      {
        content: '是一种用途广泛、结构复杂的计算机',
        id: 60055686437,
        sort: 2,
        type: 'text',
      },
      {
        content: '只可进行科学计算',
        id: 60055686438,
        sort: 3,
        type: 'text',
      },
    ],
    point: '3.0',
    type: 'multiple_selection',
  };
  const ai = await AIModel.init(true);
  const resolver = createResolver(
    question.type as SubjectType,
    question as Subject,
    ai!,
  );
  const println = (a: OptionId[]) => {
    console.log(
      a.flatMap(
        (v) => question.options.find((opt) => opt.id == v)?.content ?? [],
      ),
    );
  };

  let answer = await resolver.getAnswer();
  println(answer);

  await resolver.addAnswerFilter(
    3,
    ...question.options.map((opt) => opt.id).slice(0, 1),
  );
  answer = await resolver.getAnswer();
  println(answer);
});
