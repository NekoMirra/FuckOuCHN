import test, { expect } from '@playwright/test';
import { indexToLabel, labelToIndex } from '../src/ai/AIModel.js';

test('选项标签 A/Z/AA 转换', async () => {
    const pairs: Array<[number, string]> = [
        [0, 'A'],
        [1, 'B'],
        [25, 'Z'],
        [26, 'AA'],
        [27, 'AB'],
        [51, 'AZ'],
        [52, 'BA'],
    ];

    for (const [i, l] of pairs) {
        expect(indexToLabel(i)).toBe(l);
        expect(labelToIndex(l)).toBe(i);
        // 允许大小写
        expect(labelToIndex(l.toLowerCase())).toBe(i);
    }
});
