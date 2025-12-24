import { Page } from 'playwright';

import { CourseType, Processor } from '../processor.js';

export default class Material implements Processor {
  name: CourseType = 'material';

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
      }
    }
  }
}
