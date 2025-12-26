import { Page } from 'playwright';

import fs from 'fs';
import path from 'path';

import { fileURLToPath } from 'url';
import { dirname } from 'path';

import { CourseProgress, CourseInfo } from './search.js';
import Config from '../config.js';

const COURSE_TYPE = {
  web_link: '线上链接',
  material: '参考资料',
  homework: '作业',
  forum: '讨论',
  online_video: '音视频教材',
  slide: '微课',
  lesson: '录播教材',
  lesson_replay: '教室录播',
  exam: '测试',
  chatroom: 'iSlide 直播',
  classroom: '随堂测试',
  questionnaire: '调查问卷',
  page: '页面',
  scorm: '第三方教材',
  interaction: '互动教材',
  feedback: '教学反馈',
  virtual_classroom: 'Connect 直播',
  zoom: 'Zoom 直播',
  microsoft_teams_meeting: 'Teams 直播',
  webex_meeting: 'Webex 直播',
  welink: 'Welink',
  tencent_meeting: '课堂直播',
  classin: 'ClassIn 直播',
  live_record: '直播',
  select_student: '选人',
  race_answer: '抢答',
  number_rollcall: '数字点名',
  qr_rollcall: '二维码点名',
  dingtalk_meeting: '钉钉会议',
  virtual_experiment: '虚拟仿真实验',
  mix_task: '复合任务',
  vocabulary: '词汇表',
  unknown: '未知',
};

function getCourseType(key: CourseType) {
  return COURSE_TYPE[key];
}

function hasCourseType(key: string) {
  return key in COURSE_TYPE;
}

type StrategyFunc = (page: Page, progress: CourseProgress) => Promise<void>;

type CourseType = keyof typeof COURSE_TYPE;

interface Processor {
  name: CourseType;
  /**
   * 回调
   * 执行条件, true 执行 exec(...), 反之不执行
   * condition == null 同样执行 exec(...)
   * @param 课程信息
   */
  condition?: (courseInfo: CourseInfo) => Promise<boolean>;
  /**
   * 处理课程逻辑
   * @param page 当前页面对象
   */
  exec: (page: Page) => Promise<void>;
}

type ProcessorCtor = new () => Processor;

// IMPORTANT:
// Processor 默认导出是 class，我们必须「每次处理课程」都创建新实例。
// 否则在并发模式下，单例 Processor 内部保存的状态（例如 ExamProc.#courseInfo）会被不同 worker 覆盖，
// 导致出现 “error course info is null / Cannot read properties of undefined (reading 'activityId')”。
const processorTable: Partial<Record<CourseType, ProcessorCtor>> = {};

function registerProcessor(ctor: ProcessorCtor, name: CourseType) {
  processorTable[name] = ctor;
}

function getProcessor(name: CourseType) {
  const ctor = processorTable[name];
  return ctor ? new ctor() : void 0;
}

function isProcessor(obj: any): obj is Processor {
  return (
    typeof obj === 'object' &&
    obj != null &&
    typeof obj.name === 'string' &&
    hasCourseType(obj.name) &&
    (obj.condition === void 0 || typeof obj.condition === 'function') &&
    typeof obj.exec == 'function'
  );
}

// 视频类处理器名称列表
const VIDEO_PROCESSORS: CourseType[] = ['online_video', 'lesson', 'lesson_replay', 'slide'];

// 判断处理器是否应该启用（细粒度控制）
function shouldEnableProcessor(name: CourseType): boolean {
  // 视频类
  if (VIDEO_PROCESSORS.includes(name)) {
    return Config.features.enableVideo;
  }

  // 测试类 - 独立控制
  switch (name) {
    case 'exam':
      return Config.features.enableExam;
    case 'classroom':
      return Config.features.enableClassroom;
    case 'page':
      return Config.features.enablePage;
    case 'material':
      return Config.features.enableMaterial;
    case 'forum':
      return Config.features.enableForum;
    case 'web_link':
      return Config.features.enableWebLink;
    case 'homework':
      return Config.features.enableHomework;
    case 'tencent_meeting':
      return Config.features.enableTencentMeeting;
  }

  // 未分类的处理器默认启用
  return true;
}

// 获取当前模块的路径
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// 定义脚本文件夹路径
const scriptsFolder = path.join(__dirname, 'processor');

// 读取目录中的所有脚本文件
fs.readdirSync(scriptsFolder)
  .filter((s) => s.endsWith('.js')) // 过滤出 .js 文件
  .forEach(async (file) => {
    const filePath = path.join(scriptsFolder, file);

    // 将文件路径转换为 file:// URL 格式
    const fileUrl = new URL(`file://${filePath}`);

    await import(fileUrl.href) // 使用合法的 file:// URL
      .then((m) => {
        const Ctor = m.default as ProcessorCtor;
        const processor = new Ctor();

        if (isProcessor(processor)) {
          // 根据功能开关决定是否注册
          if (shouldEnableProcessor(processor.name)) {
            registerProcessor(Ctor, processor.name);
            console.log(`✅ 已注册处理器: ${processor.name} (${getCourseType(processor.name)})`);
          } else {
            console.log(`⏭️ 跳过处理器: ${processor.name} (${getCourseType(processor.name)}) - 功能已关闭`);
          }
        } else {
          throw new Error(`文件: ${filePath} 不是一个 Processor`);
        }
      })
      .catch((e) => {
        console.error(`Error loading ${file}`);
        throw e;
      });
  });

export type { CourseType, Processor, StrategyFunc };

export { getCourseType, hasCourseType, getProcessor, registerProcessor };
