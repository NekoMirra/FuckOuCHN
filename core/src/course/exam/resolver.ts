import AIModel from '../../ai/AIModel.js';
import { SubjectType } from '../../api/Exam.js';
import BaseSubjectResolver, { Subject } from './BaseSubjectResolver.js';
import MultipleSelection from './MultipleSelection.js';
import SingleSelection from './SingleSelection.js';
import ShortAnswer from './ShortAnswer.js';
import TrueOrFalse from './TrueOrFalse.js';

export const s2s: Record<SubjectType, string> = {
  random: '随机题目',
  text: '文本',
  true_or_false: '选择题',
  single_selection: '单选题',
  multiple_selection: '多选题',
  short_answer: '简答题',
};

const table: Partial<
  Record<
    SubjectType,
    new (subject: Subject, aiModel: AIModel) => BaseSubjectResolver
  >
> = {
  single_selection: SingleSelection,
  true_or_false: TrueOrFalse,
  multiple_selection: MultipleSelection,
  short_answer: ShortAnswer,
};

export function hasResolver(type: SubjectType) {
  return Object.hasOwn(table, type);
}

export function createResolver(
  type: SubjectType,
  subject: Subject,
  aiModel: AIModel,
) {
  const ResolverClass = table[type];
  if (ResolverClass) {
    return new ResolverClass(subject, aiModel);
  } else {
    throw new Error(`No resolver found for type ${type}`);
  }
}
