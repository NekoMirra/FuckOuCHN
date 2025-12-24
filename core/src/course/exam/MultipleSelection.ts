import { OptionId } from '../../api/Exam.js';
import BaseSubjectResolver, { BatchRequestItem } from './BaseSubjectResolver.js';

class MultipleSelection extends BaseSubjectResolver {
  private pass = false;
  private solvedAnswer?: OptionId[];
  private tried = new Set<string>();

  private normalize(ids: OptionId[]) {
    return ids.slice().sort((a, b) => a - b).join(',');
  }

  override getBatchRequestData(): BatchRequestItem | null {
    if (this.pass) return null;

    return {
      id: this.subject.id,
      type: 'multiple_selection',
      description: this.subject.description,
      options: this.subject.options.map((o) => o.content),
    };
  }

  async addAnswerFilter(score: number, ...optionIds: OptionId[]) {
    // score!=0：在该平台中（至少选择题/多选题）通常意味着“全对”，可以通过“未选集合”反推正确答案
    if (score != 0) {
      const wrongSet = new Set(optionIds);
      const solved = this.subject.options
        .filter((opt) => !wrongSet.has(opt.id))
        .map((opt) => opt.id);
      this.solvedAnswer = solved;
      this.pass = true;
      this.tried.add(this.normalize(solved));
      return;
    }

    if (optionIds.length) {
      this.tried.add(this.normalize(optionIds));
    }
  }

  async getAnswer(): Promise<OptionId[]> {
    if (this.pass && this.solvedAnswer) return this.solvedAnswer;

    const { options, description } = this.subject;

    // 优先使用预获取的结果
    if (this._prefetchedResult?.indices?.length) {
      const indices = this._prefetchedResult.indices;
      this.clearPrefetchedResult();
      let ids = indices
        .filter((i) => i >= 0 && i < options.length)
        .map((i) => options[i].id);

      // 避免重复提交相同集合
      const key = this.normalize(ids);
      if (!this.tried.has(key)) {
        this.tried.add(key);
        return ids;
      }
    }

    // 没有预获取或预获取结果已尝试过，使用 AI 实时请求
    let ids: OptionId[] = [];
    try {
      const indices = await this.aiModel.getMultiResponse(
        'multiple_selection',
        description,
        options.map((o) => o.content),
      );
      ids = indices
        .map((i) => options[i])
        .filter(Boolean)
        .map((o) => o.id);
    } catch (e) {
      // 兜底：AI 失败时，随机挑 2 个（如果只有 1 个选项就挑 1 个）
      console.warn('多选题 AI 解析失败，使用兜底策略:', String(e));
      const k = Math.min(2, options.length);
      ids = options.slice(0, k).map((o) => o.id);
    }

    // 避免重复提交相同集合
    const key = this.normalize(ids);
    if (this.tried.has(key)) {
      // 简单扰动：翻转最后一个选项
      const all = options.map((o) => o.id);
      const set = new Set(ids);
      const last = all[all.length - 1];
      if (set.has(last)) set.delete(last);
      else set.add(last);
      ids = Array.from(set);
    }

    this.tried.add(this.normalize(ids));
    return ids;
  }

  isPass(): boolean {
    return this.pass;
  }

  /**
   * 重置状态（当分数不达预期时调用，丢弃历史收集的错误答案）
   */
  reset(): void {
    this.pass = false;
    this.solvedAnswer = undefined;
    this.tried.clear();
    this.clearPrefetchedResult();
  }
}

export default MultipleSelection;
