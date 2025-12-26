import { AxiosResponse } from 'axios';
import { CourseType, CourseProgress } from '../course/search.js';
import { newAxiosInstance } from './axiosInstance.js';

type ActivityType = 'learning_activities' | 'exams' | 'classrooms';

const Api = newAxiosInstance();

type CourseModuleItem = {
  id: number;
  name?: string;
  title?: string;
};

/**
 * 课程完成度信息
 */
type CourseCompleteness = {
  completed_result: {
    completed: {
      exam_activity?: number[];
      learning_activity?: number[];
    };
    total_activities: number;
    total_completed: number;
  };
  study_completeness: number;
  last_activity?: {
    id: number;
    title: string;
    type: string;
    activity_type: string;
    module_id: number;
  };
};

/**
 * 活动阅读记录
 */
type ActivityRead = {
  activity_id: number;
  activity_type: 'learning_activity' | 'exam_activity';
  completeness: 'full' | 'part' | 'none';
  data?: {
    completeness?: number;
    score?: number;
  };
  last_visited_at: string;
};

/**
 * 活动信息
 */
type ActivityInfo = {
  id: number;
  title: string;
  type: string; // 'online_video' | 'page' | 'material' | 'exam' | 'forum' | 'web_link' | 'classroom' | ...
  hidden: boolean;
  module_id: number;
  syllabus_id?: number;
  // 排序字段
  sort?: number;
  // 解锁条件：null=无条件 | { type: 'after_learning_activity', data: { activity_id: number } }
  unlock_condition?: {
    type: string;
    data?: { activity_id?: number; activity_ids?: number[] };
  } | null;
  // 是否已解锁（前端计算）
  is_unlocked?: boolean;
  // 考试特有字段
  activity_final_score?: number;
  submit_times?: number;
  is_started?: boolean;
  is_closed?: boolean;
};

async function getCourseModules(courseId: number) {
  // 该站点接口在不同学校/版本下可能存在路径差异：/course/{id}/modules vs /courses/{id}/modules
  // 这里做一次兜底重试，避免因 404 导致整体流程不可用。
  const tryUrls = [`course/${courseId}/modules`, `courses/${courseId}/modules`];

  let lastErr: any;
  for (const url of tryUrls) {
    try {
      return await Api.get(url, {
        params: {
          // 常见字段：只取 id/name 以减少体积；若后端不识别 fields 会忽略。
          fields: 'id,name,title',
        },
      });
    } catch (e) {
      lastErr = e;
    }
  }

  throw lastErr;
}

async function getMyCourses(page: number, page_size: number) {
  return await Api.get('my-courses', {
    params: {
      conditions: JSON.stringify({ status: ['ongoing'], keyword: '' }),
      fields: `id,name,course_code,department(id,name),grade(id,name),klass(id,name),course_type,cover,small_cover,start_date,end_date,is_started,is_closed,academic_year_id,semester_id,credit,compulsory,second_name,display_name,created_user(id,name),org(is_enterprise_or_organization),org_id,public_scope,course_attributes(teaching_class_name,copy_status,tip,data),audit_status,audit_remark,can_withdraw_course,imported_from,allow_clone,is_instructor,is_team_teaching,academic_year(id,name),semester(id,name),instructors(id,name,email,avatar_small_url),is_master,is_child,has_synchronized,master_course(name)`,
      page,
      page_size,
    },
  });
}

// https://lms.ouchn.cn/api/course/60000094011/all-activities?module_ids=[60000632770]&activity_types=learning_activities,exams,classrooms
async function getAllActivities(
  courseId: number,
  moduleIds: number[],
  activityTypes: ActivityType[],
) {
  return await Api.get(`course/${courseId}/all-activities`, {
    params: {
      module_ids: `[${moduleIds.join(',')}]`,
      // 该参数在后端通常按逗号分隔解析；某些实现对空格比较敏感。
      activity_types: activityTypes.join(','),
    },
  });
}

/**
 * 返回两个Cookie, 提交某些操作需要携带
 * @param courseType
 * @param id
 * @returns BENSESSCC_TAG session
 */
function activitiesRead(courseType: CourseType, id: number) {
  return new Promise<AxiosResponse>((resolve, reject) => {
    // 限制 Qps
    Api.post(`course/activities-read/${courseType}/${id}`)
      .then((v) => setTimeout(() => resolve(v), 5000))
      .catch(reject);
  });
}

/**
 * 获取课程完成度信息（高效 API）
 * 返回已完成的活动 ID 列表和总活动数
 */
async function getCourseCompleteness(courseId: number): Promise<CourseCompleteness> {
  const resp = await Api.get(`course/${courseId}/my-completeness`);
  return resp.data;
}

/**
 * 获取用户在课程中的所有活动阅读记录（高效 API）
 * 返回每个活动的完成状态：full/part/none
 */
async function getActivityReadsForUser(courseId: number): Promise<ActivityRead[]> {
  const resp = await Api.get(`course/${courseId}/activity-reads-for-user`);
  return resp.data?.activity_reads ?? [];
}

/**
 * 检查活动是否已解锁
 * 根据 unlock_condition 和已完成的活动列表判断
 */
function checkActivityUnlocked(
  act: ActivityInfo,
  completedLearning: Set<number>,
  completedExams: Set<number>,
): boolean {
  const condition = act.unlock_condition;

  // 无解锁条件，默认解锁
  if (!condition) return true;

  // 根据解锁条件类型判断
  switch (condition.type) {
    case 'after_learning_activity':
      // 需要完成指定的学习活动
      const requiredId = condition.data?.activity_id;
      if (requiredId && !completedLearning.has(requiredId)) {
        return false;
      }
      break;

    case 'after_learning_activities':
      // 需要完成多个学习活动
      const requiredIds = condition.data?.activity_ids ?? [];
      for (const id of requiredIds) {
        if (!completedLearning.has(id)) {
          return false;
        }
      }
      break;

    case 'after_exam_activity':
      // 需要完成指定的考试活动
      const requiredExamId = condition.data?.activity_id;
      if (requiredExamId && !completedExams.has(requiredExamId)) {
        return false;
      }
      break;

    // 其他未知条件类型，保守起见视为未解锁
    default:
      // 如果有条件但不识别，记录日志并返回 false
      console.warn(`⚠️ 未识别的解锁条件类型: ${condition.type}，活动: ${act.title}`);
      return false;
  }

  return true;
}

/**
 * 高效获取课程所有活动及完成状态（纯 API，无需 DOM）
 *
 * 1. 获取 modules 列表
 * 2. 获取 all-activities（所有活动）
 * 3. 获取 my-completeness（已完成列表）
 * 4. 合并计算每个活动的完成状态
 * 5. 按 module 顺序 + sort 字段排序
 * 6. 过滤掉未解锁的活动
 *
 * @returns 所有活动及其完成状态（已按顺序排列，已过滤锁定活动）
 */
async function getUncompletedActivitiesFast(courseId: number): Promise<{
  activities: Array<ActivityInfo & { progress: CourseProgress; moduleId: string; moduleName: string; moduleSort: number }>;
  completeness: number;
  totalActivities: number;
  completedCount: number;
}> {
  // 1. 并发获取 modules + completeness
  const [modulesResp, completenessData] = await Promise.all([
    getCourseModules(courseId),
    getCourseCompleteness(courseId),
  ]);

  const modules: Array<{ id: number; name: string; sort?: number }> = modulesResp.data?.modules ?? [];
  const moduleIds = modules.map((m) => m.id);
  const moduleMap = new Map(modules.map((m) => [m.id, m.name ?? String(m.id)]));
  // 模块排序映射：module_id -> sort
  const moduleSortMap = new Map(modules.map((m, idx) => [m.id, m.sort ?? idx]));

  if (moduleIds.length === 0) {
    return {
      activities: [],
      completeness: completenessData.study_completeness ?? 0,
      totalActivities: completenessData.completed_result?.total_activities ?? 0,
      completedCount: completenessData.completed_result?.total_completed ?? 0,
    };
  }

  // 2. 获取所有活动
  const activitiesResp = await getAllActivities(courseId, moduleIds, [
    'learning_activities',
    'exams',
    'classrooms',
  ]);
  const activitiesData = activitiesResp.data ?? {};

  // 3. 构建已完成集合
  const completedExams = new Set(completenessData.completed_result?.completed?.exam_activity ?? []);
  const completedLearning = new Set(completenessData.completed_result?.completed?.learning_activity ?? []);

  // 4. 合并所有活动
  const allActivities: Array<ActivityInfo & { progress: CourseProgress; moduleId: string; moduleName: string; moduleSort: number }> = [];

  // learning_activities
  const learningActivities: ActivityInfo[] = activitiesData.learning_activities ?? [];
  for (const act of learningActivities) {
    if (act.hidden) continue;
    // 跳过已关闭的活动
    if (act.is_closed === true) continue;

    const progress: CourseProgress = completedLearning.has(act.id) ? 'full' : 'none';
    // 只返回未完成的活动
    if (progress !== 'full') {
      // 检查是否已解锁
      const isUnlocked = checkActivityUnlocked(act, completedLearning, completedExams);

      allActivities.push({
        ...act,
        progress,
        is_unlocked: isUnlocked,
        moduleId: String(act.module_id ?? ''),
        moduleName: moduleMap.get(act.module_id) ?? 'unknown',
        moduleSort: moduleSortMap.get(act.module_id) ?? 999,
      });
    }
  }

  // exams
  const exams: ActivityInfo[] = activitiesData.exams ?? [];
  for (const act of exams) {
    if (act.hidden) continue;
    // 跳过已关闭或未开始的考试
    if (act.is_closed === true) continue;
    if (act.is_started === false) continue;

    const progress: CourseProgress = completedExams.has(act.id) ? 'full' : 'none';
    // 只返回未完成的活动
    if (progress !== 'full') {
      // 检查是否已解锁
      const isUnlocked = checkActivityUnlocked(act, completedLearning, completedExams);

      allActivities.push({
        ...act,
        progress,
        is_unlocked: isUnlocked,
        moduleId: String(act.module_id ?? ''),
        moduleName: moduleMap.get(act.module_id) ?? 'unknown',
        moduleSort: moduleSortMap.get(act.module_id) ?? 999,
      });
    }
  }

  // classrooms
  const classrooms: ActivityInfo[] = activitiesData.classrooms ?? [];
  for (const act of classrooms) {
    if (act.hidden) continue;
    // 跳过已关闭的活动
    if (act.is_closed === true) continue;

    const progress: CourseProgress = completedExams.has(act.id) ? 'full' : 'none';
    // 只返回未完成的活动
    if (progress !== 'full') {
      // 检查是否已解锁
      const isUnlocked = checkActivityUnlocked(act, completedLearning, completedExams);

      allActivities.push({
        ...act,
        progress,
        is_unlocked: isUnlocked,
        moduleId: String(act.module_id ?? ''),
        moduleName: moduleMap.get(act.module_id) ?? 'unknown',
        moduleSort: moduleSortMap.get(act.module_id) ?? 999,
      });
    }
  }

  // 5. 按顺序排序：先按 moduleSort，再按活动类型优先级（exam 优先），最后按活动 sort
  const typePriority: Record<string, number> = {
    exam: 0,
    classroom: 1,
    learning_activity: 2,
  };

  allActivities.sort((a, b) => {
    if (a.moduleSort !== b.moduleSort) return a.moduleSort - b.moduleSort;

    const pa = typePriority[a.type] ?? 3;
    const pb = typePriority[b.type] ?? 3;
    if (pa !== pb) return pa - pb;

    const sortA = a.sort ?? 999;
    const sortB = b.sort ?? 999;
    return sortA - sortB;
  });

  // 6. 过滤掉未解锁的活动（但保留信息用于日志）并打印最终顺序
  const unlockedActivities = allActivities.filter((act) => {
    if (act.is_unlocked === false) {
      console.log(`🔒 活动被锁定，需先完成前置活动: ${act.title}`);
      return false;
    }
    return true;
  });

  // 日志输出：展示最终将要执行的活动顺序与状态，便于排查顺序问题
  console.log('[API] 最终活动顺序:');
  for (const act of unlockedActivities) {
    console.log(`  - moduleSort=${act.moduleSort} sort=${act.sort ?? '-'} type=${act.type} started=${String(act.is_started)} closed=${String(act.is_closed)} progress=${act.progress} title=${act.title}`);
  }

  return {
    activities: unlockedActivities,
    completeness: completenessData.study_completeness ?? 0,
    totalActivities: completenessData.completed_result?.total_activities ?? 0,
    completedCount: completenessData.completed_result?.total_completed ?? 0,
  };
}

export default {
  activitiesRead,
  getCourseModules,
  getMyCourses,
  getAllActivities,
  getCourseCompleteness,
  getActivityReadsForUser,
  getUncompletedActivitiesFast,
};

export type { ActivityType, CourseModuleItem, CourseCompleteness, ActivityRead, ActivityInfo };
