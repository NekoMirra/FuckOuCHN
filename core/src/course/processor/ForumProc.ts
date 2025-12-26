import { Page } from 'playwright';

import { Processor } from '../processor.js';

import { CourseInfo, CourseType } from '../search.js';

export default class ForumProc implements Processor {
  name: CourseType = 'forum';

  async condition(info: CourseInfo) {
    // ...就算发帖还是完成一半的状态...可能是国开系统bug...我们直接跳过
    return info.progress != 'part';
  }

  async exec(page: Page) {
    // 直接复制别人的...
    const topic = page.locator('.forum-topic-detail').first();

    // 等待论坛话题加载
    try {
      await topic.waitFor({ state: 'visible', timeout: 15000 });
    } catch {
      console.warn('ForumProc: forum-topic-detail not found, skipping');
      return;
    }

    const titleLocator = topic.locator('.topic-title');
    const contentLocator = topic.locator('.topic-content');

    // 等待标题和内容元素
    try {
      await titleLocator.waitFor({ state: 'visible', timeout: 10000 });
    } catch {
      console.warn('ForumProc: topic-title not found, skipping');
      return;
    }

    const title = await titleLocator.textContent();
    const content = await contentLocator.textContent();

    const publishBtn = page.getByText('发表帖子');
    await publishBtn.click();

    const form = page.locator('.topic-form-section');
    const titleInput = form.locator('input[name="title"]');
    const contentInput = form.locator('.simditor-body>p');
    await titleInput.fill(title!);
    await contentInput.fill(content!);

    await page
      .locator('#add-topic-popup .form-buttons')
      .getByRole('button', { name: '保存' })
      .click();
  }
}
