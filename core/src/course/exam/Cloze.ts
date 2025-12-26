import { SubjectType } from '../../api/Exam.js';
import FillInBlank from './FillInBlank.js';

/**
 * 完形填空：继承填空题处理逻辑
 */
class Cloze extends FillInBlank {
    protected override type: SubjectType = 'cloze';
}

export default Cloze;
