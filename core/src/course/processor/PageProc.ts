import { Page } from 'playwright';
import ProgressBar from 'progress';
import { CourseType, Processor } from '../processor.js';
import { waitForSPALoaded } from '../../utils.js';
import Config from '../../config.js';

export default class PageProc implements Processor {
  name: CourseType = 'page';

  async exec(page: Page) {
    await page.waitForTimeout(200);
    
    // 先尝试检测视频，不依赖full-screen-mode-content
    const hasVideo = await this.detectAndPlayVideo(page);
    if (hasVideo) {
      console.log('📺 页面包含视频，已按倍速播放完成');
      return;
    }
    
    // 没有视频，尝试按PDF/阅读逻辑处理
    const rightScreen = page.locator('div.full-screen-mode-content');

    // 等待元素可见，如果超时则跳过
    try {
      await rightScreen.waitFor({ state: 'visible', timeout: 15000 });
    } catch {
      console.warn('PageProc: 未找到可处理的内容，跳过');
      return;
    }

    // 没有视频，按原来的 PDF/阅读逻辑处理
    let scrollH = await rightScreen.evaluate((element) => {
      element.scrollTo({
        left: 0,
        top: element.scrollHeight,
        behavior: 'smooth',
      });
      return element.scrollHeight;
    });

    console.log(`scroll to ${scrollH}`);

    await waitForSPALoaded(page);

    const iframeHtml = page
      .frameLocator('#previewContentInIframe')
      .locator('html');
    try {
      await iframeHtml.waitFor({ state: 'visible', timeout: 7000 });
    } catch {
      // console.warn("not pdf or other? (can't find anything)");
      return;
    }

    scrollH = await iframeHtml.evaluate((element) => {
      element.scrollTo({
        left: 0,
        top: element.scrollHeight,
        behavior: 'smooth',
      });
      return element.scrollHeight;
    });

    console.log(`scroll to ${scrollH}`);
  }

  /**
   * 检测页面是否有视频，如果有则按倍速播放完成
   * @returns 是否检测到并播放了视频
   */
  private async detectAndPlayVideo(page: Page): Promise<boolean> {
    // 检测主页面和 iframe 中的视频
    const videoCount = await page.locator('video').count();
    let iframeVideoCount = 0;

    try {
      const iframe = page.frameLocator('#previewContentInIframe');
      iframeVideoCount = await iframe.locator('video').count();
    } catch {
      // iframe 不存在，忽略
    }

    if (videoCount === 0 && iframeVideoCount === 0) {
      return false;
    }

    console.log(`🎬 检测到视频元素 (主页面: ${videoCount}, iframe: ${iframeVideoCount})`);

    // 确定视频所在位置
    const videoInIframe = iframeVideoCount > 0;
    const videoLocator = videoInIframe
      ? page.frameLocator('#previewContentInIframe').locator('video').first()
      : page.locator('video').first();

    // 等待视频元素可见
    try {
      await videoLocator.waitFor({ state: 'visible', timeout: 10000 });
    } catch {
      console.warn('⚠️ 视频元素不可见，跳过');
      return false;
    }

    // 设置播放倍速并播放
    const playRate = Config.playRate;
    console.log(`⚡ 设置播放倍速: ${playRate}x`);

    // 简化播放逻辑：直接设置倍速、静音并播放
    await videoLocator.evaluate(
      (video, rate) => {
        const v = video as HTMLVideoElement;
        v.playbackRate = rate;
        v.muted = true;
        v.play().catch(() => console.warn('播放失败'));
      },
      playRate
    );

    // 获取视频时长
    const duration = await videoLocator.evaluate((video) => (video as HTMLVideoElement).duration);

    if (!duration || isNaN(duration) || duration <= 0) {
      console.warn('⚠️ 无法获取视频时长，等待固定时间');
      await page.waitForTimeout(5000);
      return true;
    }

    const totalSeconds = Math.ceil(duration);
    const progress = new ProgressBar('🎬 播放中 [:bar] :percent :current/:total秒', {
      head: '>',
      incomplete: ' ',
      total: totalSeconds,
      width: 30,
      clear: true,
    });

    // 监控播放进度
    let lastTime = 0;
    const checkInterval = setInterval(async () => {
      try {
        const currentTime = await videoLocator.evaluate((video) => (video as HTMLVideoElement).currentTime);
        const tick = Math.floor(currentTime) - lastTime;
        if (tick > 0) {
          progress.tick(tick);
          lastTime = Math.floor(currentTime);
        }
      } catch {
        // 忽略错误
      }
    }, 1000);

    // 等待视频播放结束
    try {
      await videoLocator.evaluate(
        (video) => {
          const v = video as HTMLVideoElement;
          return new Promise<void>((resolve) => {
            const checkEnd = () => {
              if (v.ended || v.currentTime >= v.duration - 0.5) {
                resolve();
              } else {
                setTimeout(checkEnd, 1000);
              }
            };
            checkEnd();
          });
        },
        { timeout: 0 }
      );
    } catch {
      console.warn('⚠️ 等待视频播放超时');
    }

    clearInterval(checkInterval);
    progress.terminate();
    return true;
  }
}
