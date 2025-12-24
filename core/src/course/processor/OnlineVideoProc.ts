import { expect } from '@playwright/test';
import { Page } from 'playwright';
import ProgressBar from 'progress';
import { CourseType, Processor } from '../processor.js';
import { waitForSPALoaded } from '../../utils.js';
import Config from '../../config.js';

export default class OnlineVideoProc implements Processor {
  name: CourseType = 'online_video';

  async exec(page: Page) {
    await waitForSPALoaded(page);

    const mediaType = await this.detectMediaType(page);
    if (!mediaType) {
      console.warn('❌ 未检测到音视频元素，跳过');
      return;
    }

    console.log('✅ 检测到媒体类型:', mediaType);

    await this.setPlaybackRate(page, mediaType);
    const [start, end] = await this.getMediaTime(page, mediaType);

    if (start === end && end !== '00:00') return;

    await this.preparePlayback(page, mediaType);
    const totalSeconds = this.timeStringToNumber(end);
    const progress = this.createProgress(
      this.timeStringToNumber(start),
      totalSeconds,
    );

    // 启动视频状态监控与进度条更新
    const cleanupFns = [
      this.monitorPlayback(page),
      this.trackProgress(page, progress, mediaType, end),
    ];

    // 等待播放结束
    await this.waitForPlaybackEnd(page, mediaType);

    // 清理
    cleanupFns.forEach((fn) => fn());
    console.log('✅ 播放完毕');
  }

  // -------------------------------
  // 🧩 工具方法区域
  // -------------------------------

  private async detectMediaType(page: Page): Promise<'video' | 'audio' | ''> {
    if (await page.locator('video').count()) {
      await this.showVideoControls(page);
      return 'video';
    }
    if (await page.locator('audio').count()) {
      return 'audio';
    }
    return '';
  }

  private async showVideoControls(page: Page) {
    await page
      .locator('div.mvp-replay-player-all-controls')
      .evaluate((el) => el.classList.remove('mvp-replay-player-hidden-control'))
      .catch(() => {});
  }

  private async setPlaybackRate(page: Page, mediaType: 'video' | 'audio') {
    await page.evaluate(
      ({ type, rate }) => {
        const media = document.querySelector(type) as HTMLMediaElement;
        if (media) media.playbackRate = rate;
      },
      { type: mediaType, rate: Config.playRate },
    );
  }

  private async getMediaTime(
    page: Page,
    mediaType: 'video' | 'audio',
  ): Promise<[string, string]> {
    const [start, end] =
      mediaType === 'video'
        ? (await page.locator('div.mvp-time-display').textContent())!.split('/')
        : [
            (await page.locator('.current-time').textContent())!,
            (await page.locator('.duration').textContent())!,
          ];
    return [start.trim(), end.trim()];
  }

  private async preparePlayback(page: Page, mediaType: 'video' | 'audio') {
    if (mediaType === 'video') {
      await this.showVideoControls(page);
      await this.trySetVideoQuality(page);
      await this.clickSafely(page, '.mvp-toggle-play.mvp-first-btn-margin');
    } else {
      await this.clickSafely(page, '.play');
      await this.clickSafely(page, '.volume');
    }
  }

  private async trySetVideoQuality(page: Page) {
    try {
      await page.locator('.mvp-player-quality-menu').hover({ timeout: 500 });
      await page.getByText('480p').click({ timeout: 500 });
      console.log('🎞️ 切换视频画质为 480p');
    } catch {
      console.warn('⚠️ 无法切换画质，跳过');
    }
  }

  private async clickSafely(page: Page, selector: string) {
    const el = page.locator(selector);
    try {
      await expect(el).toBeVisible({ timeout: 1000 });
      await el.click();
    } catch {
      console.warn(`⚠️ 元素 ${selector} 不可点击`);
    }
  }

  private monitorPlayback(page: Page) {
    let lastCur = '';
    let checkCount = 0;
    const interval = setInterval(async () => {
      try {
        checkCount++;
        // 前 5 次检查（10秒内）不触发重启，避免初始加载时误判
        if (checkCount <= 5) {
          lastCur = '';
          return;
        }
        
        const cur = await page.evaluate(() => {
          const el =
            document.querySelector('video') || document.querySelector('audio');
          return el ? (el as HTMLMediaElement).currentTime : 0;
        });

        const curStr = String(cur);
        if (curStr === lastCur && lastCur !== '' && lastCur !== '0') {
          console.log('⚠️ 检测到播放可能卡住，尝试重启播放');
          await this.restartPlayback(page);
        }
        lastCur = curStr;
      } catch {
        /* ignore */
      }
    }, 2000);

    return () => clearInterval(interval);
  }

  private async restartPlayback(page: Page) {
    try {
      await this.clickSafely(page, '.mvp-toggle-play.mvp-first-btn-margin');
      await page.waitForTimeout(500);
      await this.clickSafely(page, '.mvp-toggle-play.mvp-first-btn-margin');
    } catch (e) {
      console.warn('⚠️ 重启播放失败，尝试刷新');
      try {
        await page.reload({ timeout: 10000 });
        await page.waitForLoadState('domcontentloaded');
      } catch {
        console.error('❌ 页面刷新失败');
      }
    }
  }

  private trackProgress(
    page: Page,
    progress: ProgressBar,
    mediaType: 'video' | 'audio',
    end: string,
  ) {
    let prev = '';
    const interval = setInterval(async () => {
      const [cur] = await this.getMediaTime(page, mediaType);
      if (cur !== prev) {
        progress.tick(
          this.timeStringToNumber(cur) -
            this.timeStringToNumber(prev || '00:00'),
          {
            tcur: cur,
            tend: end,
          },
        );
        prev = cur;
      }
    }, 1000);

    return () => clearInterval(interval);
  }

  private async waitForPlaybackEnd(page: Page, mediaType: 'video' | 'audio') {
    // 先等待视频开始播放（currentTime > 0）
    await page.waitForFunction(
      ({ mediaType }) => {
        const el = document.querySelector(mediaType) as HTMLMediaElement;
        return el && el.currentTime > 0 && !el.paused;
      },
      { mediaType },
      { timeout: 30000, polling: 500 },
    ).catch(() => {
      console.warn('⚠️ 等待视频开始播放超时');
    });

    // 再等待播放结束
    await page.waitForFunction(
      ({ mediaType }) => {
        let cur = '';
        let end = '';
        if (mediaType === 'video') {
          const display = document.querySelector(
            'div.mvp-time-display',
          ) as HTMLElement;
          [cur, end] = display?.textContent?.split('/') ?? ['', ''];
        } else {
          cur =
            (document.querySelector('.current-time') as HTMLElement)
              ?.textContent ?? '';
          end =
            (document.querySelector('.duration') as HTMLElement)?.textContent ??
            '';
        }
        // 确保时间不为空、不为 00:00，且当前时间等于总时长
        const curTrim = cur.trim();
        const endTrim = end.trim();
        return curTrim === endTrim && curTrim !== '' && curTrim !== '00:00' && curTrim !== '00:00:00';
      },
      { mediaType },
      { timeout: 0, polling: 1000 },
    );
  }

  // -------------------------------
  // ⏱️ 时间处理 + 进度条
  // -------------------------------

  private createProgress(cur: number, end: number) {
    const bar = new ProgressBar('🎬 正在播放 [:bar] :percent :tcur/:tend', {
      head: '>',
      incomplete: ' ',
      total: end,
      width: 30,
      clear: true,
    });
    bar.tick(cur, {
      tcur: this.timeNumberToString(cur),
      tend: this.timeNumberToString(end),
    });
    return bar;
  }

  private timeNumberToString(sec: number): string {
    const h = Math.floor(sec / 3600)
      .toString()
      .padStart(2, '0');
    const m = Math.floor((sec % 3600) / 60)
      .toString()
      .padStart(2, '0');
    const s = Math.floor(sec % 60)
      .toString()
      .padStart(2, '0');
    return `${h}:${m}:${s}`;
  }

  private timeStringToNumber(time: string): number {
    const parts = time.split(':').map(Number);
    if (parts.some((n) => isNaN(n) || n < 0)) return 0;
    const [h, m, s] = [0, 0, 0, ...parts].slice(-3);
    return h * 3600 + m * 60 + s;
  }
}
