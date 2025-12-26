import { OptionId, SubjectType } from '../../api/Exam.js';
import BaseSubjectResolver, { BatchRequestItem } from './BaseSubjectResolver.js';

/**
 * 填空题/完形填空：需要用户填写文本内容
 * 这类题目通常没有选项，需要AI生成答案文本
 */
class FillInBlank extends BaseSubjectResolver {
    protected type: SubjectType = 'fill_in_blank';
    private pass = false;
    private triedTexts = new Set<string>();
    private cached?: string;

    override getBatchRequestData(): BatchRequestItem | null {
        if (this.pass) return null;

        return {
            id: this.subject.id,
            type: 'short_answer', // 使用简答题模式获取答案
            description: this.subject.description,
            options: [], // 填空题无选项
        };
    }

    async addAnswerFilter(score: number, ..._optionIds: OptionId[]) {
        if (score != 0) this.pass = true;
    }

    async getAnswer(): Promise<OptionId[]> {
        // 填空题不使用 optionIds
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

        // 没有预获取或预获取结果已尝试过，使用 AI 实时请求
        for (let i = 0; i < 3; i++) {
            let raw = '';
            try {
                raw = await this.aiModel.getTextResponse(this.subject.description);
            } catch (e) {
                console.warn(
                    `填空题 AI 获取失败(第 ${i + 1}/3 次)：subject=${this.subject.id} err=${String(e)}`,
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

        // 兜底
        return this.cached ?? '无法获取答案';
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

export default FillInBlank;
