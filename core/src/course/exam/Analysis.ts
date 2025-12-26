import { SubjectType } from '../../api/Exam.js';
import FillInBlank from './FillInBlank.js';

/**
 * 分析题：继承填空题/简答题处理逻辑
 * 通常需要提供详细的分析文本
 */
class Analysis extends FillInBlank {
    protected override type: SubjectType = 'analysis';
}

export default Analysis;
