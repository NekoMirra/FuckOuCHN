/**
 * 课程活动获取模块（纯 API 方式）
 *
 * 重构后完全使用 API 获取活动列表，废弃了所有 DOM 遍历代码。
 * 优势：
 * - 速度快（1-3秒 vs 5-15秒）
 * - 不会遗漏任何活动
 * - 无需页面导航
 */
import 'dotenv/config';
import { Page } from 'playwright';
import * as Activity from '../activity.js';
import CourseApi from '../api/course.js';
import { CourseType, hasCourseType } from './processor.js';
import chalk from 'chalk';

type CourseProgress = 'full' | 'part' | 'none';

type CourseInfo = {
  courseId: number;  // 课程组 ID，用于构建活动访问 URL
  moduleId: string;
  moduleName: string;
  syllabusId: string | null;
  syllabusName: string | null;
  type: CourseType;
  activityId: number;
  activityName: string;
  progress: CourseProgress;
};

function normalizeCourseTypeFromApi(v: any): CourseType {
  const t = String(v?.type ?? v?.activity_type ?? v?.activityType ?? '').trim();
  if (t) {
    const norm = t.replace(/-/g, '_');
    if (hasCourseType(norm)) return norm as CourseType;
  }
  return 'unknown';
}

/**
 * 高效获取课程活动列表（纯 API 方式）
 *
 * 流程：
 * 1. 获取 modules 列表
 * 2. 获取 all-activities
 * 3. 获取 my-completeness
 * 4. 合并计算每个活动的完成状态
 */
async function getCoursesViaApi(courseId: number): Promise<CourseInfo[]> {
  const debug = (() => {
    const v = String(process.env._DEBUG_API ?? '').trim().toLowerCase();
    return v === '1' || v === 'true' || v === 'yes';
  })();

  console.log(chalk.cyan('[API] 使用高效 API 获取活动列表...'));
  const startTime = Date.now();

  const result = await CourseApi.getUncompletedActivitiesFast(courseId);

  const elapsed = Date.now() - startTime;
  console.log(
    chalk.green(`[API] 获取成功：${result.activities.length} 个活动，` +
      `完成度 ${result.completeness}%（${result.completedCount}/${result.totalActivities}），` +
      `耗时 ${elapsed}ms`),
  );

  if (debug) {
    const typeCount = result.activities.reduce((acc, a) => {
      acc[a.type] = (acc[a.type] ?? 0) + 1;
      return acc;
    }, {} as Record<string, number>);
    console.log('[API] 活动类型分布:', typeCount);
  }

  // 转换为 CourseInfo 格式
  const courses: CourseInfo[] = result.activities.map((act) => {
    const type = normalizeCourseTypeFromApi(act);
    return {
      courseId,
      moduleId: act.moduleId,
      moduleName: act.moduleName,
      syllabusId: act.syllabus_id ? String(act.syllabus_id) : null,
      syllabusName: null,
      type,
      activityId: act.id,
      activityName: act.title ?? '',
      progress: act.progress,
    };
  });

  return courses;
}

/**
 * 获取未完成的课程活动
 *
 * @param _page - 保留参数兼容性，实际不再使用
 * @param activityInfo - 课程组信息
 */
async function getUncompletedCourses(
  _page: Page,
  activityInfo: Activity.ActivityInfo,
): Promise<CourseInfo[]> {
  console.log('正在获取未完成的课程...');
  return await getCoursesViaApi(activityInfo.id);
}

export type { CourseProgress, CourseType, CourseInfo };
export { getUncompletedCourses };
