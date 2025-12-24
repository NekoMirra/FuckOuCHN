import OpenAI from 'openai';
import 'dotenv/config';
import { exit } from 'process';
import chalk from 'chalk';
import https from 'https';

import { input } from '../utils.js';
import { SubjectType } from '../api/Exam.js';
import Config from '../config.js';
import { sleep } from 'openai/core.js';
import { format } from 'util';

type ChatCompletionCreateParams = Parameters<OpenAI['chat']['completions']['create']>[0];

function indexToLabel(index: number): string {
  // 0 -> A, 1 -> B, ... 25 -> Z, 26 -> AA ...
  if (!Number.isInteger(index) || index < 0) {
    throw new Error(`invalid index: ${index}`);
  }

  let n = index + 1;
  let s = '';
  while (n > 0) {
    n -= 1;
    s = String.fromCharCode((n % 26) + 65) + s;
    n = Math.floor(n / 26);
  }
  return s;
}

function labelToIndex(label: string): number {
  const t = String(label ?? '')
    .trim()
    .toUpperCase();

  if (!/^[A-Z]+$/.test(t)) {
    throw new Error(`invalid label: ${label}`);
  }

  let n = 0;
  for (const ch of t) {
    n = n * 26 + (ch.charCodeAt(0) - 64); // A=1
  }
  return n - 1;
}

function extractLabels(text: string): string[] {
  // 允许："A"、"B,C"、"A C"、"答案：AC"、"选A、C" 等
  const raw = String(text ?? '')
    .replace(/答案：|答案:|答案/gi, ' ')
    .toUpperCase();

  // 优先匹配以分隔符分隔的 token；其次匹配连续字母串(AC)并拆为单字母
  const tokens = raw.match(/[A-Z]{1,3}/g) ?? [];
  if (tokens.length === 0) return [];

  const labels: string[] = [];
  for (const t of tokens) {
    // 如果是连续单字母组合（如 AC），更像多选；拆开。
    if (t.length > 1 && /^[A-Z]+$/.test(t)) {
      // 对于 AA/AB 这种多字母标签，不能拆。
      // 简单规则：若长度=2 且第二个字母不是分隔（这里已无分隔），无法判定。
      // 我们认为：当 options 很多时，模型更可能返回 AA；当多选时更可能返回 AC。
      // 这里先保留原样，后续解析时若 labelToIndex 越界再尝试拆分。
      labels.push(t);
    } else {
      labels.push(t);
    }
  }
  return labels;
}

class AIModel {
  static async init(agree: boolean = false): Promise<AIModel | null> {
    if (AIModel.instance) return AIModel.instance;

    const { api, key, model, qps } = Config.ai;

    if (!(api && key && model)) {
      console.log('不自动答题(AI未加载)');
      return null;
    }

    if (!agree) {
      console.log('你真的确定需要"AI"答题吗? ');

      if ((await input('这可能有风险需要自己承担( "y" 确定): ')) != 'y') {
        console.log('程序退出');
        exit();
      }
    }

    AIModel.instance = new AIModel(api, key, model, qps);
    return AIModel.instance;
  }

  private constructor(api: string, key: string, model: string, Qps: number) {
    const proxy = Config.proxy;
    this.#model = model;

    const timeoutMsRaw = Number(process.env._AI_TIMEOUT_MS ?? 60000);
    // 最小 5s，避免误配为 0 或过小导致频繁误判超时
    this.#timeoutMs =
      Number.isFinite(timeoutMsRaw) && timeoutMsRaw > 0
        ? Math.max(5000, timeoutMsRaw)
        : 60000;

    this.#openai = new OpenAI({
      baseURL: api,
      apiKey: key,
      // OpenAI SDK 支持 timeout；同时我们在调用层也会加 AbortController 兜底
      timeout: this.#timeoutMs,
      httpAgent:
        Config.proxy &&
        new https.Agent({
          host: proxy!.host,
          port: proxy!.port,
          rejectUnauthorized: false, // 忽略 SSL 证书验证
        }),
    })!;
    this.#Qps = Qps;
  }

  private async chatCreate(
    params: ChatCompletionCreateParams,
    meta?: { purpose?: string; timeoutMs?: number },
  ): Promise<OpenAI.Chat.ChatCompletion> {
    const timeoutMs = meta?.timeoutMs ?? this.#timeoutMs;
    const purpose = meta?.purpose ? ` (${meta.purpose})` : '';

    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);

    try {
      // OpenAI SDK 的第二参数支持 request options（含 signal）。
      // 为避免版本差异导致的类型问题，这里使用 any。
      return await (this.#openai!.chat.completions.create as any)(params, {
        signal: controller.signal,
      });
    } catch (e: any) {
      // 统一将 AbortError 提示为“超时”，让上层兜底更直观。
      const name = String(e?.name ?? '');
      const code = String(e?.code ?? '');
      const msg = String(e?.message ?? e ?? '');
      const aborted =
        name === 'AbortError' ||
        code === 'ERR_CANCELED' ||
        /aborted|abort|canceled|cancelled/i.test(msg);

      if (aborted) {
        throw new Error(`AI 请求超时：${timeoutMs}ms${purpose}`);
      }
      throw e;
    } finally {
      clearTimeout(t);
    }
  }

  /**
   * 询问题目, 获取AI的回答
   *
   * @param type 题目类型
   * @param description 题目描述
   * @param options 可选项
   * @returns 返回可选项索引
   */
  async getResponse(
    type: SubjectType,
    description: string,
    options: string[],
  ): Promise<number> {
    if (options.length < 2) {
      console.error(chalk.red('意料之外的错误, 问题选项数量 < 2 ???'));
      exit();
    }

    while (this.#taskQueue.length != 0) {
      await this.#taskQueue[this.#taskQueue.length - 1];
      await sleep(1000 / this.#Qps + 300);
    }

    console.assert(this.#openai, '意外错误 OpenAI 客户端为 null');

    let content: OpenAI.Chat.ChatCompletion | null | undefined;

    const strategies: Partial<
      Record<
        SubjectType,
        (description: string, options: string[]) => Promise<typeof content>
      >
    > = {
      single_selection: this.singleSelection,
      true_or_false: this.trueOrFalse,
    };

    if (!strategies[type]) {
      throw new Error(
        `AIModel.getResponse 仅支持单选/判断，当前类型=${type}；请改用 getMultiResponse / getTextResponse`,
      );
    }

    const task = strategies[type]!.bind(this)(description, options);

    this.#taskQueue.push(task);

    content = await task;

    this.#taskQueue.pop();

    // 检查返回的 choices 是否为空
    if (!content || content.choices.length === 0) {
      console.error(chalk.red('AI 意料之外的错误：没有返回任何答案'));
      exit();
    }

    // 提取并解析 AI 返回的答案
    const responses = content.choices[0].message.content?.trim() ?? '';
    const labels = extractLabels(responses);
    if (labels.length === 0) {
      throw new Error(`解析 AI 回答出错(未找到字母): ${responses}`);
    }

    // 取第一个 label 作为单选答案
    let idx = labelToIndex(labels[0]);

    // 容错：如果 idx 越界且 label 是连续字母串（如 AC），尝试拆为单字母并取第一个
    if (idx >= options.length && /^[A-Z]{2,3}$/.test(labels[0])) {
      idx = labelToIndex(labels[0][0]);
    }

    if (!Number.isInteger(idx) || idx < 0 || idx >= options.length) {
      throw new Error(
        `AI 回答序号超出范围: label=${labels[0]} idx=${idx} options=${options.length} raw=${responses}`,
      );
    }

    return idx;
  }

  /**
   * 多选题：返回多个选项索引（去重、按升序）。
   */
  async getMultiResponse(
    type: SubjectType,
    description: string,
    options: string[],
  ): Promise<number[]> {
    if (type !== 'multiple_selection') {
      throw new Error(`getMultiResponse 仅用于 multiple_selection，当前=${type}`);
    }
    if (options.length < 2) {
      console.error(chalk.red('意料之外的错误, 问题选项数量 < 2 ???'));
      exit();
    }

    while (this.#taskQueue.length != 0) {
      await this.#taskQueue[this.#taskQueue.length - 1];
      await sleep(1000 / this.#Qps + 300);
    }

    const task = this.multipleSelection.bind(this)(description, options);
    this.#taskQueue.push(task);
    const content = await task;
    this.#taskQueue.pop();

    const raw = content?.choices?.[0]?.message?.content?.trim() ?? '';
    const tokens = extractLabels(raw);
    if (tokens.length === 0) {
      throw new Error(`解析 AI 多选回答出错(未找到字母): ${raw}`);
    }

    const indices: number[] = [];
    for (const t of tokens) {
      // 先尝试当作标签（A/AA），若越界且像 AC，拆成单字母
      try {
        const i = labelToIndex(t);
        if (i >= 0 && i < options.length) indices.push(i);
        else if (/^[A-Z]{2,3}$/.test(t)) {
          for (const ch of t.split('')) {
            const j = labelToIndex(ch);
            if (j >= 0 && j < options.length) indices.push(j);
          }
        }
      } catch {
        // ignore
      }
    }

    const uniq = Array.from(new Set(indices)).sort((a, b) => a - b);
    if (uniq.length === 0) {
      throw new Error(`AI 多选回答全部越界/无效: raw=${raw}`);
    }
    return uniq;
  }

  /**
   * 简答题：返回答案文本。
   */
  async getTextResponse(description: string): Promise<string> {
    while (this.#taskQueue.length != 0) {
      await this.#taskQueue[this.#taskQueue.length - 1];
      await sleep(1000 / this.#Qps + 300);
    }

    const task = this.shortAnswer.bind(this)(description);
    this.#taskQueue.push(task);
    const content = await task;
    this.#taskQueue.pop();

    const raw = content?.choices?.[0]?.message?.content?.trim() ?? '';
    if (!raw) throw new Error('AI 简答题返回为空');

    // 轻量清洗：去掉“答案：”前缀
    return raw.replace(/^\s*(答案：|答案:|答案)\s*/i, '').trim();
  }

  async trueOrFalse(description: string, options: string[]) {
    const [questionContent, systemConstraint] = this.constraintTemplate(
      '判断题',
      description,
      options,
    );

    const content: OpenAI.Chat.ChatCompletion = await this.chatCreate(
      {
        messages: [
          { role: 'system', content: systemConstraint },
          { role: 'user', content: questionContent },
          { role: 'user', content: '请只返回正确答案的字母' },
        ],
        model: this.#model,
      },
      { purpose: 'true_or_false' },
    );

    return content;
  }

  async singleSelection(description: string, options: string[]) {
    const [questionContent, systemConstraint] = this.constraintTemplate(
      '选择题',
      description,
      options,
    );

    const content: OpenAI.Chat.ChatCompletion = await this.chatCreate(
      {
        messages: [
          { role: 'system', content: systemConstraint },
          { role: 'user', content: questionContent },
          { role: 'user', content: '请只返回正确答案的字母' },
        ],
        model: this.#model,
      },
      { purpose: 'single_selection' },
    );

    return content;
  }

  private constraintTemplate(
    type: string,
    description: string,
    options: string[],
  ) {
    return [
      this.questionContentTemplate(type, description, options),
      this.systemConstraintTemplate(type, options),
    ];
  }

  private questionContentTemplate(
    type: string,
    description: string,
    options: string[],
  ) {
    const questionContent = format(
      '%s\n%s\n%s\n%s',
      `请回答以下${type}，并只返回正确答案的字母：`,
      `题目：${description}`,
      '选项：',
      `${options
        .map((option, index) => `\t${indexToLabel(index)}. ${option}`)
        .join('\n')}`,
    );
    return questionContent;
  }

  private systemConstraintTemplate(type: string, options: string[]) {
    const systemConstraint = `你将回答${type}。只返回正确答案的字母(${options
      .map((_, i) => indexToLabel(i))
      .join(',')})。`;
    return systemConstraint;
  }

  async multipleSelection(description: string, options: string[]) {
    const [questionContent, systemConstraint] = this.constraintTemplate(
      '多选题',
      description,
      options,
    );

    const content: OpenAI.Chat.ChatCompletion = await this.chatCreate(
      {
        messages: [
          { role: 'system', content: systemConstraint },
          { role: 'user', content: questionContent },
          {
            role: 'user',
            content:
              '可能有多个正确选项。请只返回所有正确答案的字母，用英文逗号分隔，例如：A,C 或 B,D,E。',
          },
        ],
        model: this.#model,
      },
      { purpose: 'multiple_selection' },
    );

    return content;
  }

  async shortAnswer(description: string) {
    const systemConstraint =
      '你将回答简答题。请用中文给出简洁、直接的答案（1-3 句话），不要输出多余解释或格式。';
    const content: OpenAI.Chat.ChatCompletion = await this.chatCreate(
      {
        messages: [
          { role: 'system', content: systemConstraint },
          { role: 'user', content: `题目：${description}` },
        ],
        model: this.#model,
      },
      { purpose: 'short_answer' },
    );
    return content;
  }

  /**
   * 批量请求 AI 答案（按 QPS 分批并发）
   * @param requests 请求列表，每个包含 id、type、description、options
   * @returns 结果映射 Map<id, 答案索引数组 | 文本>
   */
  async batchRequest<T extends string | number>(
    requests: Array<{
      id: T;
      type: SubjectType;
      description: string;
      options: string[];
    }>,
  ): Promise<Map<T, { indices?: number[]; text?: string }>> {
    const results = new Map<T, { indices?: number[]; text?: string }>();
    const qps = this.#Qps;

    // 按 QPS 分批
    const batches: typeof requests[] = [];
    for (let i = 0; i < requests.length; i += qps) {
      batches.push(requests.slice(i, i + qps));
    }

    console.log(
      chalk.cyan(
        `[AI批量] 共 ${requests.length} 个请求，分 ${batches.length} 批，QPS=${qps}`,
      ),
    );

    for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
      const batch = batches[batchIdx];
      console.log(
        chalk.gray(`  批次 ${batchIdx + 1}/${batches.length}: ${batch.length} 个请求`),
      );

      // 并发执行当前批次
      const batchPromises = batch.map(async (req) => {
        try {
          if (req.type === 'short_answer') {
            const content = await this.shortAnswer(req.description);
            const raw = content?.choices?.[0]?.message?.content?.trim() ?? '';
            const text = raw.replace(/^\s*(答案：|答案:|答案)\s*/i, '').trim();
            return { id: req.id, result: { text } };
          } else if (req.type === 'multiple_selection') {
            const content = await this.multipleSelection(
              req.description,
              req.options,
            );
            const raw = content?.choices?.[0]?.message?.content?.trim() ?? '';
            const tokens = extractLabels(raw);
            const indices: number[] = [];
            for (const t of tokens) {
              try {
                const i = labelToIndex(t);
                if (i >= 0 && i < req.options.length) indices.push(i);
                else if (/^[A-Z]{2,3}$/.test(t)) {
                  for (const ch of t.split('')) {
                    const j = labelToIndex(ch);
                    if (j >= 0 && j < req.options.length) indices.push(j);
                  }
                }
              } catch {
                // ignore
              }
            }
            const uniq = Array.from(new Set(indices)).sort((a, b) => a - b);
            return { id: req.id, result: { indices: uniq.length ? uniq : [0] } };
          } else {
            // single_selection / true_or_false
            const strategies: Partial<
              Record<
                SubjectType,
                (
                  description: string,
                  options: string[],
                ) => Promise<OpenAI.Chat.ChatCompletion | null | undefined>
              >
            > = {
              single_selection: this.singleSelection.bind(this),
              true_or_false: this.trueOrFalse.bind(this),
            };

            const strategy = strategies[req.type];
            if (!strategy) {
              throw new Error(`不支持的批量请求类型: ${req.type}`);
            }

            const content = await strategy(req.description, req.options);
            const raw = content?.choices?.[0]?.message?.content?.trim() ?? '';
            const labels = extractLabels(raw);
            let idx = labels.length ? labelToIndex(labels[0]) : 0;

            // 容错
            if (idx >= req.options.length && /^[A-Z]{2,3}$/.test(labels[0])) {
              idx = labelToIndex(labels[0][0]);
            }
            if (idx < 0 || idx >= req.options.length) idx = 0;

            return { id: req.id, result: { indices: [idx] } };
          }
        } catch (e) {
          console.warn(chalk.yellow(`  [AI批量] 请求 ${req.id} 失败:`, String(e)));
          // 返回默认值
          if (req.type === 'short_answer') {
            return { id: req.id, result: { text: '无法获取答案' } };
          }
          return { id: req.id, result: { indices: [0] } };
        }
      });

      const batchResults = await Promise.all(batchPromises);

      for (const { id, result } of batchResults) {
        results.set(id, result);
      }

      // 批次间等待，避免超 QPS（除最后一批）
      if (batchIdx < batches.length - 1) {
        await sleep(1000);
      }
    }

    console.log(chalk.cyan(`[AI批量] 全部完成，共 ${results.size} 个结果`));
    return results;
  }

  get qps() {
    return this.#Qps;
  }

  #model: string;
  #openai: OpenAI;
  #Qps: number;
  #timeoutMs: number;
  #taskQueue: Array<Promise<any>> = [];

  static instance?: AIModel;
}

export type Num = 0 | 1 | 2 | 3;

export type Letter = 'A' | 'B' | 'C' | 'D';

export function num2Letter(n: Num): Letter {
  return String.fromCharCode(n + 'A'.charCodeAt(0)) as Letter;
}

export function letter2Num(c: Letter): Num {
  return (c.charCodeAt(0) - 'A'.charCodeAt(0)) as Num;
}

export { indexToLabel, labelToIndex };

export default AIModel;
