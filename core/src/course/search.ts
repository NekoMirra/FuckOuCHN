import 'dotenv/config';
import { Locator, Page } from 'playwright';
import * as Activity from '../activity.js';
import { waitForSPALoaded } from '../utils.js';
import { CourseType, hasCourseType } from './processor.js';
import Config from '../config.js';

type CourseProgress = 'full' | 'part' | 'none';

type CourseInfo = {
  moduleId: string;
  moduleName: string;
  syllabusId: string | null;
  syllabusName: string | null;
  type: CourseType;
  activityId: number;
  activityName: string;
  progress: CourseProgress;
};

async function getModulesData(locs: Array<Locator>) {
  return await Promise.all(
    locs.map(async (module) => {
      const moduleId = (await module.getAttribute('id'))!;
      const moduleName = (await module
        .locator('span.module-name')
        .textContent())!.trim();

      const syllabusesLoc = await module.locator('div.course-syllabus').all();
      const activitiesLoc = await module.locator('div.module-activities').all();

      return {
        moduleId,
        moduleName,
        module,
        syllabusesLoc: [...syllabusesLoc, ...activitiesLoc],
      };
    }),
  );
}

async function getSyllabusesData(moduleData: {
  moduleId: string;
  moduleName: string;
  module: Locator;
  syllabusesLoc: Locator[];
}) {
  const { moduleId, moduleName, module, syllabusesLoc } = moduleData;

  // 多个课程组, 如果有分数可能是考试, 我们需要在后面判断, 如果是满分就跳过, 这里先获取
  const getActivitiesList = async (loc: Locator) =>
    await loc.locator('div.learning-activities').all();

  if (syllabusesLoc.length != 0) {
    const syllabusesData = syllabusesLoc.map(async (syllabusLoc) => {
      const syllabusId = (await syllabusLoc.getAttribute('id'))!;
      const syllabusName = (await syllabusLoc
        .locator('div.syllabus-title')
        .textContent({ timeout: 100 })
        .catch(() => ''))!.trim();

      return {
        moduleId,
        moduleName,
        syllabusId,
        syllabusName,
        activitiesLocList: await getActivitiesList(syllabusLoc),
      };
    });

    return Promise.all(syllabusesData);
  }

  return [
    {
      moduleId,
      moduleName,
      syllabusId: null,
      syllabusName: null,
      activitiesLocList: await getActivitiesList(module),
    },
  ];
}

async function getUncompletedCourses(
  page: Page,
  activityInfo: Activity.ActivityInfo,
): Promise<CourseInfo[]> {
  console.log('正在获取未完成的课程...');

  //   await page.getByText(activityInfo.title).click();
  await page.goto(`${Config.urls.course()}/${activityInfo.id}/ng#/`);
  await page.waitForURL(RegExp(`^${Config.urls.course()}.*`));

  await waitForSPALoaded(page);
  await page.locator('input[type="checkbox"]').setChecked(true);

  await waitForSPALoaded(page);
  const expandBtn = page.getByText(/全部(?:收起|展开)/);

  const expandText = ((await expandBtn.textContent().catch(() => '')) ?? '').trim();
  // 仅当按钮显示“展开”时点击（“收起”表示当前已展开）
  if (expandText.includes('展开')) {
    await expandBtn.click();
    await page.waitForLoadState('domcontentloaded');
  }

  await waitForSPALoaded(page);
  const modules = await page.locator('div.module').all();
  const modulesData = await getModulesData(modules);

  const syllabusesData = (
    await Promise.all(modulesData.map(getSyllabusesData))
  ).flat();

  // some stuff is finished, so is empty, we need skip
  const hasContentActivity = async (activity: Locator) => {
    return await activity.locator(':nth-child(n)').count();
  };

  // 过滤无内容和隐藏的活动 usableActivities
  const activitiesAsync = syllabusesData.flatMap((syllabus) =>
    syllabus.activitiesLocList.map(async (activitiesLoc) => {
      const activityLocList = await activitiesLoc
        .locator('div.learning-activity')
        .all();

      return (
        await Promise.all(
          activityLocList.map(async (activityLoc) =>
            (await hasContentActivity(activityLoc))
              ? (await getActivityName(activityLoc)) == ''
                ? []
                : {
                  moduleId: syllabus.moduleId,
                  moduleName: syllabus.moduleName,
                  syllabusId: syllabus.syllabusId,
                  syllabusName: syllabus.syllabusName,
                  type: await getActivityType(activityLoc),
                  activityId: await getActivityId(activityLoc),
                  activityName: await getActivityName(activityLoc),
                  activityLoc,
                }
              : [],
          ),
        )
      ).flat();
    }),
  );

  const activities = (await Promise.all(activitiesAsync)).flat();

  // 最后填充进度和活动名
  const coursesData = activities.map(async (activity) => {
    const complete = activity.activityLoc.locator(
      'activity-completeness-bar div.completeness',
    );

    // 完成进度
    const progress = await complete
      .getAttribute('class', { timeout: 10000 })
      .then(String)
      .catch(() => 'none');

    const resolveList: CourseProgress[] = ['full', 'part'];
    const resolveProgress =
      resolveList.find((v) => progress.includes(v)) ?? 'none';

    const courseData: {
      activityLoc: any;
    } & CourseInfo = { ...activity, progress: resolveProgress };

    delete courseData.activityLoc;

    return courseData;
  });

  return Promise.all(coursesData);
}

async function getActivityName(activity: Locator) {
  try {
    const titleElt = activity.locator('div.activity-title a.title');
    const title = await titleElt.evaluate((e) => {
      return e.textContent;
    });
    if (!title) {
      console.log(activity);
      return '';
    }
    return title;
  } catch (e) {
    return '';
  }
}

async function getActivityType(activity: Locator): Promise<CourseType> {
  const icon = activity.locator('div.activity-icon>i.font');
  const cls = await icon.getAttribute('class');
  const prefix = 'font-syllabus-';
  if (cls) {
    const fStart = cls.indexOf(prefix);
    const front = cls.substring(fStart);
    const courseType = front.substring(prefix.length).replace('-', '_');
    if (hasCourseType(courseType)) return courseType as CourseType;
  }
  return 'unknown';
}

async function getActivityId(activity: Locator): Promise<number> {
  const id = (await activity.getAttribute('id'))!;
  const prefix = 'learning-activity-';
  return Number(id.substring(prefix.length));
}

export type { CourseProgress, CourseType, CourseInfo };
export { getUncompletedCourses };
