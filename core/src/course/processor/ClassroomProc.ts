import { CourseType } from '../processor.js';
import ExamProc from './ExamProc.js';

/**
 * 随堂测试：目前多数学校的随堂测试与“测试(exam)”后端接口一致，
 * 因此直接复用 ExamProc 的答题逻辑。
 *
 * 若后端路径不同（例如 /classrooms/...），后续可按抓包结果再拆分为独立 API。
 */
export default class ClassroomProc extends ExamProc {
    name: CourseType = 'classroom';
}
