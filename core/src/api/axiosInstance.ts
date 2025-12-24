import axios, { HttpStatusCode } from 'axios';
import Config, { API_BASE_URL } from '../config.js';
import { restoreCookies } from '../login.js';
import { exit } from 'process';

function normalizeCookieHeaderValue(v: string) {
  return String(v ?? '')
    .trim()
    .replace(/;\s*$/, '');
}

function newAxiosInstance(url: string = '') {
  if (url) url = '/' + url;

  const proxy = Config.proxy;

  const axiosInstance = axios.create({
    baseURL: `${API_BASE_URL}/api${url}`,
    withCredentials: true,
    timeout: 20000,
    proxy: proxy && {
      ...proxy,
      protocol: 'http',
    },
  });

  axiosInstance.interceptors.request.use(async (config) => {
    // 伪造请求头, 绕过反爬系统
    // PS: 傻鸟网站, 提交答案的时候检测很严格
    config.headers['User-Agent'] =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36';
    config.headers['Accept'] = 'application/json, text/plain, */*';
    config.headers['Accept-Language'] = 'zh-CN,zh;q=0.9,en;q=0.8';

    config.headers['Origin'] = API_BASE_URL;
    // 某些接口会校验 Referer；给一个稳定的站内 Referer，避免 403。
    config.headers['Referer'] = `${API_BASE_URL}/user/index#/`;

    config.headers['Pragma'] = 'no-cache';
    config.headers['Cache-Control'] = 'no-cache';
    config.headers['sec-ch-ua-platform'] = 'Windows';
    config.headers['sec-ch-ua'] =
      '"Not A(Brand";v="8", "Chromium";v="132", "Google Chrome";v="132"';
    config.headers['sec-ch-ua-mobile'] = '?0';
    config.headers['Sec-Fetch-Site'] = 'same-origin';
    config.headers['Sec-Fetch-Mode'] = 'cors';
    config.headers['Sec-Fetch-Dest'] = 'empty';
    config.headers['dnt'] = '1';
    config.headers['sec-gpc'] = '1';

    const defaultCookie = normalizeCookieHeaderValue(
      (axiosInstance.defaults.headers['Cookie'] ?? '') as string,
    );

    const restored = await restoreCookies();
    const extraPairs = restored.flatMap((cookie) => {
      // 简单去重：如果 defaultCookie 已包含该键，则不再追加
      if (defaultCookie.includes(`${cookie.name}=`)) return [];
      return `${cookie.name}=${cookie.value}`;
    });

    // ⚠️ 之前这里是字符串直接相加：defaultCookie + join('; ')
    // 若 defaultCookie 非空且末尾没有 ';'，会变成 "a=bk=c"，服务器可能直接 400。
    const parts = [defaultCookie, ...extraPairs].filter(Boolean);
    config.headers['Cookie'] = parts.join('; ');

    return config;
  });

  axiosInstance.interceptors.response.use(async (response) => {
    switch (response.status) {
      case HttpStatusCode.Found:
      case HttpStatusCode.BadRequest:
        console.error(response.data.message ?? response.data);
        console.warn('获取信息失败', '需要登陆?');
        exit();
    }
    return response;
  });

  return axiosInstance;
}

export { newAxiosInstance };
