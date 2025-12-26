import AIModel from '../../ai/AIModel.js';
import { OptionId, SubjectId, SubjectType } from '../../api/Exam.js';

export type Option = {
  // 可选答案
  content: string; // 答案描述
  id: OptionId; // 答案id
  type: string; // 类型
};

export type Subject = {
  // 题目组
  description: string; // 题目
  id: SubjectId;
  last_updated_at: string; // ISO time
  options: Option[];
  point: string; // 得分百分比
  type: SubjectType;
  parentDescription?: string; // 父题目描述（用于 cloze 等复合题型的子题目）
};

/**
 * 批量请求的数据结构
 */
export type BatchRequestItem = {
  id: SubjectId;
  type: SubjectType;
  description: string;
  options: string[];
};

/**
 * 批量结果的数据结构
 */
export type BatchResultItem = {
  indices?: number[];
  text?: string;
};

abstract class BaseSubjectResolver {
  private _subject: Subject;
  private _aiModel: AIModel;
  protected _prefetchedResult?: BatchResultItem;

  get subject() {
    return this._subject;
  }

  get aiModel() {
    return this._aiModel;
  }

  constructor(subject: Subject, aiModel: AIModel) {
    this._subject = subject;
    this._aiModel = aiModel;
  }

  /**
   * 添加一个选项数组, 下次判读会排除
   *
   * @param score 得分百分比
   * @param optionIds 此次错误选项集合
   */
  abstract addAnswerFilter(
    score: number,
    ...optionIds: OptionId[]
  ): Promise<void>;

  abstract getAnswer(): Promise<OptionId[]>;

  /**
   * 可选：当题型需要文本答案（如 short_answer）时返回文本。
   * 默认不提供。
   */
  async getAnswerText(): Promise<string | undefined> {
    return void 0;
  }

  abstract isPass(): boolean;

  /**
   * 获取批量请求所需的数据（如果需要请求 AI）
   * 返回 null 表示该题目不需要 AI 请求（已有答案或已通过）
   */
  getBatchRequestData(): BatchRequestItem | null {
    if (this.isPass()) return null;

    return {
      id: this._subject.id,
      type: this._subject.type,
      description: this._subject.description,
      options: this._subject.options.map((o) => o.content),
    };
  }

  /**
   * 设置预获取的 AI 答案结果
   */
  setPrefetchedResult(result: BatchResultItem): void {
    this._prefetchedResult = result;
  }

  /**
   * 清除预获取的结果
   */
  clearPrefetchedResult(): void {
    this._prefetchedResult = undefined;
  }

  /**
   * 重置状态（当分数不达预期时调用，丢弃历史收集的错误答案）
   */
  abstract reset(): void;
}

export default BaseSubjectResolver;
