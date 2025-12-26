import { Page } from 'playwright';

import { CourseType, Processor } from '../processor.js';

export default class Material implements Processor {
  name: CourseType = 'material';

  /**
   * 自动滚动 PDF/页面内容到底部
   */
  private async scrollToBottom(page: Page) {
    // 尝试滚动 file-previewer 中的内容
    const previewerContent = page.locator('#file-previewer .content, #file-previewer .file-content, #file-previewer iframe');

    try {
      // 先尝试滚动 iframe 内容（PDF 预览通常在 iframe 中）
      const iframe = page.frameLocator('#file-previewer iframe');
      const iframeBody = iframe.locator('body, html');

      if (await iframeBody.count() > 0) {
        await iframeBody.first().evaluate((el) => {
          el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
        }).catch(() => { });
        await page.waitForTimeout(500);
      }
    } catch {
      // iframe 不存在或无法访问
    }

    // 尝试滚动预览容器本身
    try {
      const container = page.locator('#file-previewer .content');
      if (await container.count() > 0) {
        await container.evaluate((el) => {
          el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
        });
        await page.waitForTimeout(500);
      }
    } catch {
      // 容器不存在
    }

    // 尝试滚动可能的 PDF 查看器容器
    try {
      const pdfViewer = page.locator('#file-previewer .pdf-viewer, #file-previewer .viewer-container, #file-previewer [class*="scroll"]');
      if (await pdfViewer.count() > 0) {
        await pdfViewer.first().evaluate((el) => {
          el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
        });
        await page.waitForTimeout(500);
      }
    } catch {
      // PDF 查看器容器不存在
    }
  }

  async exec(page: Page) {
    await page.waitForSelector('div.activity-material', { state: 'visible', timeout: 10000 }).catch(() => {
      console.log('未找到资料区域，跳过');
    });

    const pdfs = await page.locator('.activity-material a:text("查看")').all();
    console.log(`发现 ${pdfs.length} 个 PDF 资料`);

    for (let i = 0; i < pdfs.length; i++) {
      const pdf = pdfs[i];
      try {
        // 确保弹窗已关闭
        await page.locator('#file-previewer').waitFor({ state: 'hidden', timeout: 2000 }).catch(() => { });

        await pdf.click({ timeout: 5000 });

        // 等待弹窗打开
        await page.locator('#file-previewer').waitFor({ state: 'visible', timeout: 10000 });

        // 等待一小段时间让内容加载
        await page.waitForTimeout(1000);

        // 自动滚动到底部
        await this.scrollToBottom(page);
        console.log(`  📜 已滚动 PDF ${i + 1}/${pdfs.length} 到底部`);

        // 关闭弹窗
        const closeBtn = page.locator('#file-previewer .header > a.close');
        await closeBtn.click({ timeout: 5000 });

        // 等待弹窗完全关闭
        await page.locator('#file-previewer').waitFor({ state: 'hidden', timeout: 5000 });

        console.log(`  ✅ 查看 PDF ${i + 1}/${pdfs.length}`);
      } catch (e) {
        console.warn(`  ⚠️ PDF ${i + 1} 处理失败，尝试关闭弹窗继续: ${String(e).slice(0, 100)}`);
        // 尝试强制关闭弹窗
        await page.locator('#file-previewer .header > a.close').click({ timeout: 2000, force: true }).catch(() => { });
        await page.locator('#file-previewer').waitFor({ state: 'hidden', timeout: 3000 }).catch(() => { });
        // 如果还是关不掉，按 ESC
        await page.keyboard.press('Escape').catch(() => { });
        await page.waitForTimeout(500);

        // 如果弹窗仍然存在，强制重载页面
        const isStillOpen = await page.locator('#file-previewer').isVisible().catch(() => false);
        if (isStillOpen) {
          console.warn(`  🔄 弹窗无法关闭，强制重载页面...`);
          await page.reload({ timeout: 120000 }).catch(() => {
            console.error(`  ❌ 页面重载失败`);
          });
          await page.waitForTimeout(2000);
          // 重载后跳出循环，避免继续处理可能导致的错误
          break;
        }
      }
    }
  }
}
