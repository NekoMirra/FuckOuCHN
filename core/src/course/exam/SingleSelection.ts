import { format } from 'util';
import { OptionId, SubjectType } from '../../api/Exam.js';
import BaseSubjectResolver, { BatchRequestItem, Option } from './BaseSubjectResolver.js';

class SingleSelection extends BaseSubjectResolver {
  protected type: SubjectType = 'single_selection';
  private wrongOptions: Option[] = [];

  async addAnswerFilter(_: number, ...optionIds: OptionId[]) {
    this.wrongOptions = [
      ...new Set([
        ...this.wrongOptions,
        ...optionIds.map((optId) => {
          const option = this.subject.options.find(({ id }) => id == optId);
          if (!option)
            throw new Error(format("Oops! don't have:", optId, 'Option'));
          return option;
        }),
      ]),
    ];
  }

  override getBatchRequestData(): BatchRequestItem | null {
    if (this.isPass()) return null;

    // 返回过滤后的选项
    const opts = this.subject.options.flatMap((opt) =>
      new Set(this.wrongOptions.map(({ id }) => id)).has(opt.id) ? [] : opt,
    );

    return {
      id: this.subject.id,
      type: this.type,
      description: this.subject.description,
      options: opts.map((o) => o.content),
    };
  }

  async getAnswer(): Promise<OptionId[]> {
    const { options, description } = this.subject;

    if (this.wrongOptions.length == options.length) {
      throw new Error('impossable: all options is wrong!!');
    }

    // only leave one option
    if (this.isPass()) {
      const opt = options.find(
        ({ id }) => !new Set(this.wrongOptions.map(({ id }) => id)).has(id),
      );
      if (!opt) throw new Error("impossable: can't find option???");
      return [opt.id];
    }

    const opts = options.flatMap((opt) =>
      new Set(this.wrongOptions.map(({ id }) => id)).has(opt.id) ? [] : opt,
    );

    // 优先使用预获取的结果
    if (this._prefetchedResult?.indices?.length) {
      const idx = this._prefetchedResult.indices[0];
      this.clearPrefetchedResult();
      if (idx >= 0 && idx < opts.length) {
        return [opts[idx].id];
      }
    }

    const answer = await this.aiModel.getResponse(
      this.type,
      description,
      opts.map(({ content }) => content),
    );

    return [opts[answer].id];
  }

  isPass(): boolean {
    return this.subject.options.length - this.wrongOptions.length == 1;
  }
}

export default SingleSelection;
