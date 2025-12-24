/**
 * 直接测试批量 AI 请求功能
 * 用法: npx tsx ./tests/test-batch-ai.ts
 */
import 'dotenv/config';
import AIModel from '../src/ai/AIModel.js';
import { SubjectType } from '../src/api/Exam.js';

async function main() {
    console.log('=== 批量 AI 请求测试 ===\n');

    // 1. 初始化 AI
    console.log('[1] 初始化 AI...');
    const ai = await AIModel.init(true);
    if (!ai) {
        console.error('❌ AI 初始化失败，请检查 .env 配置');
        process.exit(1);
    }
    console.log('✅ AI 初始化成功');
    console.log('   QPS:', ai.qps);
    console.log();

    // 2. 准备测试题目
    const testQuestions: Array<{
        id: number;
        type: SubjectType;
        description: string;
        options: string[];
    }> = [
            // 判断题
            {
                id: 1,
                type: 'true_or_false',
                description: '毛泽东是马克思主义中国化的伟大开拓者和奠基人。',
                options: ['对', '错'],
            },
            {
                id: 2,
                type: 'true_or_false',
                description: '地球是宇宙的中心。',
                options: ['对', '错'],
            },
            // 单选题
            {
                id: 3,
                type: 'single_selection',
                description: '以下哪一次会议确立了毛泽东在全党的实际地位？',
                options: ['八七会议', '遵义会议', '党的六届六中全会', '党的七大'],
            },
            {
                id: 4,
                type: 'single_selection',
                description: '中国的首都是哪个城市？',
                options: ['上海', '北京', '广州', '深圳'],
            },
            // 多选题
            {
                id: 5,
                type: 'multiple_selection',
                description: '以下哪些是中国的直辖市？',
                options: ['北京', '上海', '广州', '天津', '重庆'],
            },
            {
                id: 6,
                type: 'multiple_selection',
                description: '毛泽东思想活的灵魂包括哪些？',
                options: ['实事求是', '群众路线', '独立自主', '绝对领导'],
            },
            // 简答题
            {
                id: 7,
                type: 'short_answer',
                description: '简述马克思主义中国化的重要意义。',
                options: [],
            },
            {
                id: 8,
                type: 'short_answer',
                description: '什么是实事求是？',
                options: [],
            },
        ];

    console.log('[2] 测试批量请求...');
    console.log(`   共 ${testQuestions.length} 道题目\n`);

    const startTime = Date.now();

    // 3. 批量请求
    const results = await ai.batchRequest(testQuestions);

    const endTime = Date.now();
    console.log(`\n[3] 批量请求完成，耗时: ${((endTime - startTime) / 1000).toFixed(2)} 秒\n`);

    // 4. 打印结果
    console.log('[4] 答案结果:\n');

    for (const question of testQuestions) {
        const result = results.get(question.id);
        console.log(`题目 ${question.id} [${question.type}]:`);
        console.log(`  问题: ${question.description.slice(0, 50)}...`);

        if (result?.indices?.length) {
            const answerLabels = result.indices.map((i) =>
                String.fromCharCode(65 + i),
            );
            console.log(`  AI答案: ${answerLabels.join(', ')}`);
            if (question.options.length > 0) {
                const answerTexts = result.indices.map((i) => question.options[i]);
                console.log(`  选项内容: ${answerTexts.join(', ')}`);
            }
        } else if (result?.text) {
            console.log(`  AI答案: ${result.text}`);
        } else {
            console.log(`  ❌ 无结果`);
        }
        console.log();
    }

    console.log('=== 测试完成 ===');
}

main().catch(console.error);
