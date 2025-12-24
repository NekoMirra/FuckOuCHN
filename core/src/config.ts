import chalk from 'chalk';
import 'dotenv/config';

const BASE_SSO_URL = 'https://iam.pt.ouchn.cn/am';

const API_BASE_URL = 'https://lms.ouchn.cn';

const { _PROXY_HOST: host, _PROXY_PORT: port } = process.env;
const { _API: api, _KEY: key, _MODEL: model, _Qps } = process.env;
const qps = Number(_Qps) || 1;

const { _ACCOUNT: account, _PASSWORD: password } = process.env;

const examMaxRetries = Math.max(0, Number(process.env._EXAM_MAX_RETRIES ?? 2));

// 功能开关
const parseEnvBool = (val: string | undefined, defaultVal: boolean): boolean => {
  if (val === undefined || val === '') return defaultVal;
  const v = val.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
};

const { _ENABLE_VIDEO, _ENABLE_EXAM } = process.env;

const Config = {
  user: {
    account,
    password,
  },
  urls: {
    login: () => BASE_SSO_URL,
    user: () => `${API_BASE_URL}/user`,
    course: () => `${API_BASE_URL}/course`,
    home: () => `${Config.urls.user()}/index#/`,
    // modules: (courseId: string) => `https://lms.ouchn/api/courses/${courseId}/modules`,
  },
  proxy: host && port ? { host: host!, port: Number(port) } : void 0,
  ai: { api, key, model, qps },
  // 功能开关
  features: {
    enableVideo: parseEnvBool(_ENABLE_VIDEO, true), // 默认开启视频刷课
    enableExam: parseEnvBool(_ENABLE_EXAM, true),   // 默认开启答题
  },

  browser: {
    headless: !!process.env._HEAD_LESS,
    slowMo() {
      const min = Number(process.env._SLOW_MO_MIN ?? 6000);
      const max = Number(process.env._SLOW_MO_MAX ?? 9000);
      console.assert(max > min);
      return Math.floor(Math.random() * (max - min + 1)) + min;
    },
  },
  playRate: Number(process.env._PLAY_RATE ?? 8),
  totalPoints: Number(process.env._TOTAL_POINTS ?? 100),
  examMaxRetries,
};

function printConfigStatus() {
  console.log('\n========== 功能开关 ==========');
  console.log('视频刷课:', Config.features.enableVideo ? '✅ 开启' : '❌ 关闭');
  console.log('自动答题:', Config.features.enableExam ? '✅ 开启' : '❌ 关闭');
  console.log('================================\n');
  console.log('视频倍速:', Config.playRate);
  console.log('考试分数及格线(百分比):', Config.totalPoints);
  console.log('考试最多重试次数:', Config.examMaxRetries);

  if (Config.browser.headless) {
    console.log('无头模式已启用');
  }

  if (Config.ai && Config.ai.api && Config.ai.key && Config.ai.model) {
    console.log('AI已启用:');
    console.log('API', Config.ai.api);
    console.log('Key', '*'.repeat(Config.ai.key.length));
    console.log('Model', Config.ai.model);
  }

  if (Config.proxy) {
    console.log(
      '代理:',
      chalk.green(`http://${Config.proxy.host}:${Config.proxy.port}`),
    );
  }
}

export default Config;

export { API_BASE_URL, printConfigStatus };
