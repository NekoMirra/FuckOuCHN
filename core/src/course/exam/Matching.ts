import { OptionId, SubjectType } from '../../api/Exam.js';
import BaseSubjectResolver, { BatchRequestItem } from './BaseSubjectResolver.js';

/**
 * 匹配题：将左边项目与右边项目配对
 * 目前使用AI生成匹配建议，通过简答形式返回
 */
class Matching extends BaseSubjectResolver {
    protected type: SubjectType = 'matching';
    private pass = false;
    private triedTexts = new Set<string>();
    private cached?: string;

    override getBatchRequestData(): BatchRequestItem | null {
        if (this.pass) return null;

        // 构造匹配题的描述，包含所有选项信息
        const optionsDesc = this.subject.options
            .map((o, i) => `${i + 1}. ${o.content}`)
            .join('\n');
        
        const fullDesc = `${this.subject.description}\n\n可选项：\n${optionsDesc}\n\n请根据题目要求，给出正确的匹配关系。`;

        return {
            id: this.subject.id,
            type: 'short_answer', // 使用简答题模式
            description: fullDesc,
            options: [],
        };
    }

    async addAnswerFilter(score: number, ..._optionIds: OptionId[]) {
        if (score != 0) this.pass = true;
    }

    async getAnswer(): Promise<OptionId[]> {
        // 匹配题可能需要返回选项ID，但具体取决于API结构
        // 如果API接受option_ids，这里尝试解析AI返回的匹配关系
        return [];
    }

    async getAnswerText(): Promise<string | undefined> {
        if (this.pass) return this.cached;

        // 优先使用预获取的结果
        if (this._prefetchedResult?.text) {
            const t = this._prefetchedResult.text.replace(/\s+/g, ' ').trim();
            this.clearPrefetchedResult();
            if (t && !this.triedTexts.has(t)) {
                this.triedTexts.add(t);
                this.cached = t;
                return t;
            }
        }

        // 没有预获取，使用 AI 实时请求
        for (let i = 0; i < 3; i++) {
            let raw = '';
            try {
                const optionsDesc = this.subject.options
                    .map((o, i) => `${i + 1}. ${o.content}`)
                    .join('\n');
                
                const prompt = `${this.subject.description}\n\n可选项：\n${optionsDesc}\n\n请给出正确的匹配关系。`;
                raw = await this.aiModel.getTextResponse(prompt);
            } catch (e) {
                console.warn(
                    `匹配题 AI 获取失败(第 ${i + 1}/3 次)：subject=${this.subject.id} err=${String(e)}`,
                );
                break;
            }

            const t = raw.replace(/\s+/g, ' ').trim();

            if (!t) continue;
            if (this.triedTexts.has(t)) continue;

            this.triedTexts.add(t);
            this.cached = t;
            return t;
        }

        return this.cached ?? '无法获取匹配答案';
    }

    isPass(): boolean {
        return this.pass;
    }

    reset(): void {
        this.pass = false;
        this.triedTexts.clear();
        this.cached = undefined;
        this.clearPrefetchedResult();
    }
}

export default Matching;
