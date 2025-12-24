import { Axios, AxiosResponse, HttpStatusCode } from 'axios';
import { newAxiosInstance } from './axiosInstance.js';
import { API_BASE_URL } from '../config.js';

// true_or_false 判断题
// single_selection 单选题
// text 概要,一般用来分割不同类型题目, 或是题目选项描述
//   example:
//   一、单项选择题
//    ....
//   二、判断题
//    ....
export type SubjectType =
  | 'random'
  | 'text'
  | 'true_or_false'
  | 'single_selection'
  | 'multiple_selection'
  | 'short_answer';
export type SubjectId = number;
export type OptionId = number;

export default class {
  #activityId: number;
  #axios: Axios;

  get activityId() {
    return this.#activityId;
  }

  constructor(activityId: number) {
    this.#activityId = activityId;
    this.#axios = newAxiosInstance(`exams/${activityId}`);
    // 为了过检测
    this.#axios.defaults.headers.common['Referer'] =
      `${API_BASE_URL}/exam/${activityId}/subjects`;
  }

  addCookies(cookies: Array<{ name: string; value: string }>) {
    // console.log('Exam add Cookies:\n', cookies);

    const headers = this.#axios.defaults.headers;
    headers.common['Cookie'] = cookies
      .map((cookie) => `${cookie.name}=${cookie.value}`)
      .join('; ');
  }

  async get() {
    const response = await this.#axios.get('');
    return response.data;
  }

  /**
   * 获取课程概述
   *
   * @param forAllSubjects 是否获取所有课程?
   *
   * @return
   * ```json
   * {
   *     "subjects": [
   *         {
   *             "has_audio": false,
   *             "id": 60022713245,
   *             "point": "25.0",
   *             "sub_subjects": [] // 如果type是random 那么这里是随机题目的类型
   *             "type": "true_or_false"
   *         },
   *         {
   *              "has_audio": false,
   *              "id": 60020719291,
   *              "point": "4.0",
   *              "sub_subjects": [
   *                  {
   *                      "point": "4.0",
   *                      "type": "single_selection"
   *                  },
   *                  {
   *                      "point": "4.0",
   *                      "type": "single_selection"
   *                  },
   *                  ...
   *              ],
   *              "type": "random"
   *          },
   *         ...
   *     ]
   * }
   * ```
   * */
  async getSubjectsSummary(forAllSubjects: boolean) {
    const response = await this.#axios.get('subjects-summary', {
      params: { forAllSubjects },
    });

    const subjectsSummary: {
      subjects: Array<{
        has_audio: boolean;
        id: SubjectId;
        point: string;
        sub_subjects: Array<any>;
        type: SubjectType;
      }>;
    } = response.data;

    return subjectsSummary;
  }

  /**
   * 获取所有提交记录
   *
   * @return
   * ```json
   * {
   *  "exam_final_score": null,
   *  "exam_score": 100.0, // 当前最高的得分
   *  "exam_score_rule": "highest",
   *  "submissions": [
   *      {
   *          "created_at": "2024-10-17T12:12:18Z",
   *          "exam_id": 60000512656,
   *          "exam_type_text": "测试试题",
   *          "id": 60092024720,
   *          "score": "100.0",
   *          "submitted_at": "2024-10-17T12:13:29Z"
   *      }
   *      ...
   *  ]
   * }
   * ```
   */
  async getSubmissions() {
    const response = await this.#axios
      .get('submissions')
      .catch((resp: AxiosResponse) => {
        if (resp.status == HttpStatusCode.NotFound) return { data: {} };
        throw resp.statusText;
      });

    const submissions: {
      exam_final_score: number | undefined | null;
      exam_score: number | undefined;
      exam_score_rule: string | undefined;
      submissions:
      | Array<{
        created_at: string;
        exam_id: number;
        exam_type_text: string;
        id: SubjectId;
        score: string | null;
        submitted_at: string;
      }>
      | undefined;
    } = response.data;

    return submissions;
  }

  /**
   * 获取指定考试记录信息
   * @param id 考试记录id
   */
  async getSubmission(id: SubjectId) {
    const response = await this.#axios.get(`submissions/${id}`);
    const submission: {
      score: number;
      subjects_data: {
        subjects: Array<{
          id: SubjectId;
          description: string; // 标题
          point: string; // 分数 number 3.0
          type: SubjectType;
          options: Array<{
            content: string; // 题目选项内容
            id: OptionId;
            sort: number;
            type: SubjectType;
          }>;
        }>;
      };
      submission_data: {
        subjects: Array<{
          answer_option_ids: OptionId[];
          subject_id: SubjectId;
          subject_updated_at: string;
        }>;
        // _fixed: boolean
      };
      submission_score_data: Record<SubjectId, string>; // string is float
    } = response.data;

    return submission;
  }

  /**
   * 获取题目描述
   * 不能重复获取, 一次考试获取一次
   * 只要一次验证错误这个就废了
   *
   * @return
   * ```json
   * {
   *  "exam_paper_instance_id": 60091054740,
   *  "subjects": [
   *    {
   *      "description": "<p>一、单项选择题<\p>",
   *      "id": 60022713235,
   *      "options": [],
   *      "point": "0.0",
   *      "type": "text"
   *    },
   *    {
   *      ...,
   *      "options": [
   *        {
   *          "content": "<p>社会主义核心价值观<p>"
   *          "id": 60060738293,
   *          "type": "text"
   *        },
   *        ...
   *      ],
   *      "point": "25.0",
   *      "type": "single_selection"
   *      ]
   *    },
   *    ...
   *  ]
   * }
   * ```
   */
  async getDistribute() {
    const response = await this.#axios.get('distribute');

    const distribute: {
      exam_paper_instance_id: number;
      subjects: Array<{
        // 题目组
        description: string; // 题目
        id: SubjectId;
        last_updated_at: string; // ISO time
        options: Array<{
          // 可选答案
          content: string; // 答案描述
          id: OptionId; // 答案id
          type: string; // 类型
        }>;
        point: string; // 得分百分比
        type: SubjectType;
      }>;
    } = response.data;

    return distribute;
  }

  /**
   * 提交存储, 当开始答题需要调用, 消耗一次答题机会
   * 只是相当于标记已经开始答题
   * 只要一次验证错误这个就废了
   *
   * @see getDistribute
   *
   * @return 当你提交答案时需要带上 id
   */
  async submissionsStorage(
    distribute: Awaited<ReturnType<typeof this.getDistribute>>,
  ): Promise<number | undefined> {
    const url = 'submissions/storage';
    let response = await this.#axios.get(url).catch(() => void 0);

    if (!response || response.status == HttpStatusCode.NotFound) {
      const subjects = distribute.subjects.filter(
        (subject) => subject.type != 'text',
      );

      response = await this.#axios.post(url, {
        exam_paper_instance_id: distribute.exam_paper_instance_id,
        exam_submission_id: null,
        subjects: subjects.map((subject) => ({
          subject_id: subject.id,
          subject_updated_at: subject.last_updated_at,
          answer_option_ids: [],
        })),
        progress: {
          answered_num: 0,
          total_subjects: distribute.subjects.length,
        },
      });
    }

    return response?.data['id'];
  }

  /**
   * 提交答案, 不能频繁提交
   *
   * @param examPaperInstanceId 同 submissionStorage
   * @param examSubmissionId submissionStorage返回值
   * @param subjects 答案数组
   * @param totalSubjects 同 submissionStorage
   */
  async postSubmissions(
    examPaperInstanceId: number,
    examSubmissionId: number,
    subjects: Array<{
      subjectId: SubjectId;
      answerOptionIds: OptionId[];
      answerText?: string;
      updatedAt: string;
    }>,
    totalSubjects: number,
  ) {
    const response = await this.#axios.post('submissions', {
      exam_paper_instance_id: examPaperInstanceId,
      exam_submission_id: examSubmissionId,
      progress: {
        answered_num: subjects.length,
        total_subjects: totalSubjects,
      },
      reason: 'user',
      subjects: subjects.map((subject) => ({
        subject_id: subject.subjectId,
        answer_option_ids: subject.answerOptionIds,
        ...(subject.answerText ? { answer_text: subject.answerText } : {}),
        subject_updated_at: subject.updatedAt,
      })),
    });

    return response.data;
  }
}
