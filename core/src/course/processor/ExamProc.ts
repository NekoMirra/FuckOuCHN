import { AxiosError, HttpStatusCode } from 'axios';
import chalk from 'chalk';
import { Page } from 'playwright';
import { exit } from 'process';
import { sleep } from 'openai/core.js';

import { Processor } from '../processor.js';

import AIModel, { indexToLabel } from '../../ai/AIModel.js';
import course from '../../api/course.js';
import Exam, { OptionId, SubjectId } from '../../api/Exam.js';
import { parseDOMText } from '../../utils.js';
import BaseSubjectResolver, { BatchRequestItem } from '../exam/BaseSubjectResolver.js';
import { createResolver, hasResolver, s2s } from '../exam/resolver.js';
import { CourseInfo, CourseType } from '../search.js';
import Config from '../../config.js';

/**
 * score当你全部答对就是100, point是得分百分比, 比如总分112, 实际你exam_score最大为: 100
 */
export default class ExamProc implements Processor {
  name: CourseType = 'exam';

  #courseInfo?: CourseInfo;
  #totalPoints: number = Config.totalPoints;
  #totalScore: number = -1;

  // config
  private maxRetries = Config.examMaxRetries;

  async condition(info: CourseInfo) {
    this.#courseInfo = info;
    console.log('id:', info.activityId);
    const exam = new Exam(info.activityId);

    if (!AIModel.instance) {
      console.log('AI 未加载: skip');
      return false;
    }

    const support = await this.checkExamRunnable(exam);
    if (!support.ok) {
      console.log(`${support.reason}: skip`);
      return false;
    }

    return true;
  }

  async exec(page: Page) {
    console.assert(this.#courseInfo, 'error course info is null');
    console.assert(AIModel.instance, 'error ai model is null');

    const exam = new Exam(this.#courseInfo!.activityId);
    const subjectResolverList: Partial<Record<SubjectId, BaseSubjectResolver>> =
      {};

    // 过滤出所有问题
    let q = await this.pullQuestions(
      exam,
      page,
      AIModel.instance!,
      subjectResolverList,
    );

    if (q) {
      // need 'BENSESSCC_TAG' Cookie
      const response = await course.activitiesRead(
        this.name,
        this.#courseInfo!.activityId,
      );
      const cookies = response.headers['set-cookie'];

      if (!cookies) {
        console.error(chalk.red('获取Cookie失败: 未知错误'));
        exit();
      }

      exam.addCookies(
        cookies.flatMap((cookie) => {
          const raw = cookie.split(';');
          const [k, v] = raw[0].split('=');
          return { name: k, value: v };
        }),
      );
    }

    for (let retry = 0; q && retry <= this.maxRetries; retry++) {
      const { questions, examPaperInstanceId, subjects, total } = q;

      const submissionId = await exam.submissionsStorage({
        exam_paper_instance_id: examPaperInstanceId,
        subjects,
      });

      if (!submissionId) {
        console.log('意料之外的错误:', "can't get submissionId");
        exit();
      }

      // 批量获取 AI 答案
      await this.batchPrefetchAnswers(questions, subjectResolverList, AIModel.instance!);

      const answerSubjects = await Promise.all(
        questions.map(async (subject) => {
          const resolver = subjectResolverList[subject.id];

          if (!resolver) {
            console.error(subject);
            throw new Error(
              `Oops! impossable!! can't found resolver: ${subject.id} ${subject.type}`,
            );
          }

          const answerOptionIds = await resolver.getAnswer();
          const answerText = await resolver.getAnswerText();

          if (!resolver.isPass()) {
            // 打印题目
            console.log(
              chalk.bgGreenBright(
                `${' '.repeat(10)}${s2s[subject.type]} ${' '.repeat(10)}`,
              ),
            );

            console.log(subject.description);
            const entries = subject.options.entries();

            for (const [i, v] of entries) {
              console.log(`\t${indexToLabel(i)}. ${v.content}`);
            }

            console.log(
              'AI 回答:',
              subject.options.flatMap(({ id }, i) =>
                answerOptionIds.includes(id) ? indexToLabel(i) : [],
              ),
              answerOptionIds,
            );

            if (answerText) {
              console.log('AI 简答:', answerText);
            }

            console.log();
          }

          return {
            subjectId: subject.id,
            answerOptionIds,
            answerText,
            updatedAt: subject.last_updated_at,
          };
        }),
      );

      const waitTime = total * 200 + Math.random() * 5 * 100;
      console.log((waitTime / 1000).toFixed(2), '秒后提交');

      await page.waitForTimeout(waitTime);

      await this.submitAnswer(
        exam,
        examPaperInstanceId,
        submissionId,
        answerSubjects,
        total,
      );

      q = await this.pullQuestions(
        exam,
        page,
        AIModel.instance!,
        subjectResolverList,
      );

      if (q) {
        if (retry >= this.maxRetries) {
          console.log('已达到最大重试次数, 跳过本次考试');
          break;
        }

        console.log('分数未达预期, 重新执行');
        console.log('尝试次数:', retry + 1);

        const waitTime = total * 1000;
        console.log(waitTime / 1000, '秒后重新开始答题');
        await page.waitForTimeout(waitTime);
      }
    }

    // 可复用的, 需要清除
    this.#courseInfo = undefined;
    this.#totalScore = -1;
  }

  // 提交答案
  private async submitAnswer(
    exam: Exam,
    examPaperInstanceId: number,
    submissionId: number,
    subjects: Array<{
      subjectId: SubjectId;
      answerOptionIds: OptionId[];
      answerText?: string;
      updatedAt: string;
    }>,
    totalSubjects: number,
  ) {
    let r;
    let counter = 5;
    do {
      try {
        r = await exam.postSubmissions(
          examPaperInstanceId,
          submissionId,
          subjects,
          totalSubjects,
        );
      } catch (e) {
        // 这里有时候返回429并不是真的太多请求
        // 也有可能是请求头缺少某些字段,导致验证失败
        if (
          e instanceof AxiosError &&
          e.response!.status === HttpStatusCode.TooManyRequests
        ) {
          console.log('太多请求, 等待10s');
          await sleep(10000);
          counter--;
          continue;
        }

        if (
          e instanceof AxiosError &&
          e.response &&
          e.response.status === HttpStatusCode.BadRequest
        ) {
          // 400 多数是参数/状态不对（例如 cookie/header 校验失败、试卷实例失效等），继续等一般无意义。
          // 打印有限诊断信息，帮助定位（注意：不输出 Cookie 等敏感信息）。
          const msg =
            (e.response.data && (e.response.data.message || e.response.data.error)) ||
            e.message;
          console.warn('提交答案返回 400:', msg);
          try {
            console.warn('400 响应数据(截断):',
              JSON.stringify(e.response.data).slice(0, 800),
            );
          } catch {
            // ignore
          }
          throw e;
        }
        throw e; // Re-throw if it's not a 429 error
      }
    } while (!r && counter > 0);
  }

  private async createSubjectResolverList(
    subjects: Awaited<
      ReturnType<typeof Exam.prototype.getDistribute>
    >['subjects'],
    aiModel: AIModel,
  ) {
    return subjects
      .filter((subject) => subject.type != 'text')
      .reduce(
        (acc, subject) => {
          acc[subject.id] = createResolver(subject.type, subject, aiModel);
          return acc;
        },
        {} as Record<SubjectId, BaseSubjectResolver>,
      );
  }

  /**
   * 提取考试历史成绩
   * @param param0
   * @returns [最新考试成绩, 历史最高分]
   */
  private async getHistoryScore({
    exam_score: examScore,
    submissions,
  }: Awaited<ReturnType<typeof Exam.prototype.getSubmissions>>): Promise<
    [number | undefined, number | undefined]
  > {
    if (examScore != void 0) {
      // 获取最新的结果
      let newestIndex = 0;
      for (let i = 1; submissions && i < submissions.length; i++) {
        if (
          new Date(submissions[newestIndex].submitted_at) <
          new Date(submissions[i].submitted_at)
        ) {
          newestIndex = i;
        }
      }

      let curScore: number | undefined = Number(
        submissions?.[newestIndex]?.score,
      );
      curScore = Number.isNaN(curScore) ? void 0 : curScore;

      console.log(
        '分数(最新/最高/总分)[%]/总分:',
        `(${curScore ?? '?'}/${examScore}/${this.#totalPoints})[%]/${this.#totalScore}`,
      );

      return [curScore, examScore];
    }

    return [void 0, void 0];
  }

  private async pullQuestions(
    exam: Exam,
    page: Page,
    aiModel: AIModel,
    subjectResolverList: Partial<Record<SubjectId, BaseSubjectResolver>>,
  ) {
    let getSubmission = await exam.getSubmissions();

    let i = 0;
    while (
      i < 5 &&
      getSubmission.submissions?.find(({ score }) => score == null)
    ) {
      console.log('等待系统评分...');
      await sleep(10000);
      getSubmission = await exam.getSubmissions();
      i++;
    }

    const [_, examScore] = await this.getHistoryScore(getSubmission);

    if (
      examScore &&
      (examScore == this.#totalPoints || examScore > this.#totalPoints)
    )
      return null;

    // 确实还不知道, 要不要重新获取问题, 有可能不重新获取亦可以? 可以复用?
    const getDistribute = await exam.getDistribute();

    const subjects = await Promise.all(
      getDistribute.subjects.map(async (subject) => {
        const options: (typeof subject)['options'] = [];

        for (const opt of subject.options) {
          options.push({
            ...opt,
            content: await parseDOMText(page, opt.content),
          });
        }

        return {
          ...subject,
          description: await parseDOMText(page, subject.description),
          options,
        };
      }),
    );

    const srl = await this.createSubjectResolverList(subjects, aiModel);

    for (const id in srl) {
      if (!subjectResolverList[id]) {
        subjectResolverList[id] = srl[id];
      }
    }

    // 答过题, 获取已知答案
    if (examScore) {
      console.log('正在收集历史考试答案...');
      // TODO: 实际上不用每次都去重新获取一遍
      for (const { id } of getSubmission.submissions!) {
        await this.collectSubmissons(id, exam, subjectResolverList);
      }
    }

    return {
      questions: subjects.filter(({ type }) => type != 'text'),
      examPaperInstanceId: getDistribute.exam_paper_instance_id,
      subjects,
      total: subjects.length,
    };
  }

  private async collectSubmissons(
    id: number,
    exam: Exam,
    subjectResolverList: Partial<Record<SubjectId, BaseSubjectResolver>>,
  ) {
    const {
      subjects_data: { subjects },
      submission_data,
      submission_score_data,
    } = await exam.getSubmission(id);

    // 收集正确 或错误答案
    // 需要注意的是, 如果是多选题, 我们无法知道哪些选项是错误的, 哪些是正确的
    for (const { subject_id, answer_option_ids } of submission_data.subjects) {
      const { options } = subjects.find(({ id }) => id == subject_id)!;
      const score = Number(submission_score_data[subject_id]); //百分比

      let filterOpts = answer_option_ids;

      if (score != 0) {
        filterOpts = options.flatMap(({ id }) =>
          answer_option_ids.includes(id) ? [] : id,
        );
      }

      await subjectResolverList[subject_id]!.addAnswerFilter(
        score,
        ...filterOpts,
      );
    }
  }

  private async checkExamRunnable(
    exam: Exam,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const examInfo = await exam.get();

    // API 返回的字段名可能是 submit_times 或 submit_limit
    // submitted_times 或 submitted_count
    const submitLimit = examInfo.submit_limit ?? examInfo.submit_times ?? null;
    const submittedCount = examInfo.submitted_count ?? examInfo.submitted_times ?? 0;
    const totalPoints = examInfo.total_points ?? 100;
    const announceScoreStatus = examInfo.announce_score_status;

    this.#totalScore = totalPoints;

    // 检查是否还能提交
    // submit_limit 为 null 表示无限次提交
    // submit_limit 为 0 表示不允许提交（练习题/案例练习等）
    if (submitLimit === 0) {
      // 练习题：不值得继续做题型检查/拉题目（也不会提交）
      console.log(
        `此考试不允许提交 (submit_limit=0) | ${examInfo.title ?? ''} | 总分:${totalPoints}`,
      );
      return { ok: false, reason: '此考试不允许提交' };
    }

    // 常规考试再输出详细信息（避免练习题刷屏）
    console.log('完成标准:', examInfo.completion_criterion);
    console.log('标题:', examInfo.title);
    console.log('成绩比例:', examInfo.score_percentage);
    console.log('题目数:', examInfo.subjects_count);
    console.log('允许提交次数:', submitLimit, '(null=无限)');
    console.log('已经提交次数:', submittedCount);
    console.log('公布成绩:', announceScoreStatus);
    console.log('总分:', totalPoints);

    // 如果有提交次数限制，检查是否超过
    if (submitLimit !== null && submittedCount >= submitLimit) {
      console.log(`已达到提交次数上限 (${submittedCount}/${submitLimit})`);
      return { ok: false, reason: '已达到提交次数上限' };
    }

    console.log('检查考试题目类型...');
    // check subject summary
    const { subjects } = await exam.getSubjectsSummary(true);

    const typeNames = subjects.flatMap((s) =>
      s.type != 'text' ? (s2s[s.type] ?? s.type) : [],
    );
    console.log('题目类型:', typeNames);

    const isSupportSubject = ({ type }: (typeof subjects)[number]) =>
      hasResolver(type) || type === 'random'; // random类型本身可能没有解析器，但需要检查其子题目

    const test = subjects
      .filter((v) => v.type != 'text')
      .every((v) =>
        v.type == 'random'
          ? v.sub_subjects?.every(isSupportSubject) || true // 如果random没有子题目，则认为支持
          : isSupportSubject(v),
      );

    if (!test) {
      const unsupported = subjects
        .filter((v) => v.type != 'text')
        .filter((v) => !isSupportSubject(v))
        .map((v) => s2s[v.type] ?? v.type);
      console.log('不支持的题目类型:', unsupported);
    }

    return test ? { ok: true } : { ok: false, reason: '题型暂不支持' };
  }

  /**
   * 批量预获取 AI 答案
   * 收集所有需要 AI 回答的题目，按 QPS 批量请求，然后将结果设置到各个 resolver
   */
  private async batchPrefetchAnswers(
    questions: Array<{ id: SubjectId; type: string; description: string; options: Array<{ id: OptionId; content: string }> }>,
    subjectResolverList: Partial<Record<SubjectId, BaseSubjectResolver>>,
    aiModel: AIModel,
  ) {
    // 收集需要 AI 回答的题目
    const batchRequests: BatchRequestItem[] = [];

    for (const question of questions) {
      const resolver = subjectResolverList[question.id];
      if (!resolver) continue;

      const reqData = resolver.getBatchRequestData();
      if (reqData) {
        batchRequests.push(reqData);
      }
    }

    if (batchRequests.length === 0) {
      console.log(chalk.gray('[批量AI] 所有题目已有答案，无需请求'));
      return;
    }

    // 批量请求 AI
    const results = await aiModel.batchRequest(batchRequests);

    // 将结果设置到对应的 resolver
    for (const [subjectId, result] of results) {
      const resolver = subjectResolverList[subjectId];
      if (resolver) {
        resolver.setPrefetchedResult(result);
      }
    }
  }
}
