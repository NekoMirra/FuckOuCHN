import { OptionId, SubjectType } from '../../api/Exam.js';
import BaseSubjectResolver, { BatchRequestItem } from './BaseSubjectResolver.js';

/**
 * 简答题：平台一般不提供 options，答案需要以文本形式提交。
 *
 * 注意：历史提交接口当前未返回 short_answer 的文本答案，因此这里无法通过历史答案"学习"，
 * 只能在得分!=0 时标记通过，供 ExamProc 终止重复提交。
 */
class ShortAnswer extends BaseSubjectResolver {
    protected type: SubjectType = 'short_answer';
    private pass = false;
    private triedTexts = new Set<string>();
    private cached?: string;

    override getBatchRequestData(): BatchRequestItem | null {
        if (this.pass) return null;

        return {
            id: this.subject.id,
            type: 'short_answer',
            description: this.subject.description,
            options: [], // 简答题无选项
        };
    }

    async addAnswerFilter(score: number, ..._optionIds: OptionId[]) {
        if (score != 0) this.pass = true;
    }

    async getAnswer(): Promise<OptionId[]> {
        // 简答题不使用 optionIds
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
                    `简答题 AI 获取失败(第 ${i + 1}/3 次)，将使用兜底：subject=${this.subject.id} err=${String(e)}`,
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

        // 兜底：允许返回最后一次
        return this.cached ?? '无法获取答案';
    }

    isPass(): boolean {
        return this.pass;
    }
}

export default ShortAnswer;
