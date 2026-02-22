# 考试答题"存在非法的題目ID"问题-完整诊断和修复指南

## 📋 问题现象

提交考试答案时返回 HTTP 400 错误：
```
提交答案返回 400: Request failed with status code 400
400 响应数据(截断): {"errors":{"subjects":[...,"存在非法的題目ID"]}}
```

**特征**：
- 错误出现在特定类型的试卷上（通常包含匹配题、完形填空等复合题目）
- 提交的题目数量看起来正确，但服务器认为某个ID无效

## 🔍 根本原因分析

### 问题的三层次结构

#### 1. 数据流不一致（数据层面）
当试卷包含 `sub_subjects` 的复合题目时：

```
API 返回的原始数据结构：
┌─ Subject (ID: 1000, type: cloze)
│  ├─ sub_subjects[0] (ID: 1001)
│  ├─ sub_subjects[1] (ID: 1002)
│  └─ sub_subjects[2] (ID: 1003)
├─ Subject (ID: 2000, type: matching)
└─ ...

期望提交的ID列表：[1001, 1002, 1003, 2000, ...]
实际发生的情况：题目展开逻辑在两个地方进行，导致ID列表不一致
```

#### 2. 展开逻辑分散（代码设计问题）
- `Exam.ts:submissionsStorage()` 方法展开了一次 sub_subjects
- `ExamProc.ts:pullQuestions()` 方法又展开了一次
- `ExamProc.ts` 提交时使用的是第二次展开的结果，但 `submissionsStorage` 注册的是第一次的

#### 3. ID 验证缺失（防御性编程不足）
即使有ID不匹配，代码也没有充分的诊断信息来识别问题

### 特定场景：匹配题（Matching）
匹配题特别容易触发这个问题，因为：
1. 匹配题本身就是一个复杂结构（左侧项、右侧选项、配对关系）
2. 如果 API 返回了子题目，需要展开处理
3. 答案格式（文本而非选项ID）增加了复杂性

## ✅ 实施的修复方案

### 修复 1：统一展开逻辑（Exam.ts）

**位置**：`core/src/api/Exam.ts:287-350`

**改进**：
```typescript
async submissionsStorage(
  distribute: Awaited<ReturnType<typeof this.getDistribute>>,
): Promise<{
  submissionId: number | undefined;
  expandedSubjects: Array<{...}>;
}> {
  // ✅ 在此处统一处理所有展开逻辑
  const expandedSubjects: Array<...> = [];
  
  for (const subject of distribute.subjects) {
    if (subject.type === 'text') continue;
    
    if (subject.sub_subjects && subject.sub_subjects.length > 0) {
      // 展开子题目
      for (const subSubject of subject.sub_subjects) {
        // 防御性检查：过滤无效ID
        if (!subSubject.id || subSubject.id <= 0) {
          console.warn(`⚠️ 跳过无效的子题目ID: ${subSubject.id}`);
          continue;
        }
        expandedSubjects.push({
          subject_id: subSubject.id,
          subject_updated_at: subSubject.last_updated_at,
          answer_option_ids: [],
        });
      }
    } else {
      // 防御性检查
      if (!subject.id || subject.id <= 0) {
        console.warn(`⚠️ 跳过无效的题目ID: ${subject.id}`);
        continue;
      }
      expandedSubjects.push({...});
    }
  }
  
  // 使用展开后的列表提交
  const response = await this.#axios.post(url, {
    exam_paper_instance_id: distribute.exam_paper_instance_id,
    exam_submission_id: null,
    subjects: expandedSubjects, // ✅ 关键：使用展开的列表
    progress: {
      answered_num: 0,
      total_subjects: expandedSubjects.length,
    },
  });
  
  return { submissionId: response?.data['id'], expandedSubjects };
}
```

**关键改进**：
- ✅ 返回 `expandedSubjects`，供调用方参考
- ✅ 在此方法内完成所有展开逻辑，确保一致性
- ✅ 添加防御性ID检查

### 修复 2：简化调用流程（ExamProc.ts）

**位置**：`core/src/course/processor/ExamProc.ts:88-100`

**改进**：
```typescript
// 直接传递完整 distribute，让 submissionsStorage 自己处理展开
const { submissionId, expandedSubjects } = await exam.submissionsStorage(
  examDistribute,
);

if (!submissionId) {
  console.log('意料之外的错误:', "can't get submissionId");
  exit();
}
```

**改进点**：
- ✅ 单一职责：submissionsStorage 负责展开
- ✅ 数据一致性：expandedSubjects 是权威来源

### 修复 3：增强诊断信息（ExamProc.ts）

**位置**：`core/src/course/processor/ExamProc.ts:158-190`

**改进**：
```typescript
// 诊断：打印完整的答案信息用于调试
if (uniqueAnswerSubjects.length !== total) {
  console.warn(`⚠️ 警告：提交的题目数量 (${uniqueAnswerSubjects.length}) 不等于总题目数 (${total})`);
  console.warn('✏️ 完整答案信息:');
  uniqueAnswerSubjects.forEach((ans, idx) => {
    console.warn(`  [${idx}] ID: ${ans.subjectId}, 选项: ${ans.answerOptionIds.join(',') || '(空)'}, 文本: ${ans.answerText ? ans.answerText.substring(0, 30) : '(无)'}`);
  });
}
```

## 🧪 验证清单

运行刷课后，检查日志中的以下内容：

- [ ] `提交subjects ids:` 显示的ID都是有效的正整数
- [ ] `totalSubjects:` 与 `subjects.length:` 相同
- [ ] 没有 `⚠️ 跳过无效的题目ID` 警告
- [ ] 没有 `⚠️ 发现重复的题目ID` 警告
- [ ] 如果长度不相等，应该能看到完整答案信息

## 📊 修复前后对比

| 方面 | 修复前 | 修复后 |
|------|--------|--------|
| 题目展开位置 | 两处（Exam.ts + ExamProc.ts） | 统一在 Exam.ts |
| ID一致性 | 容易不匹配 | 单一来源，保证一致 |
| 防御性检查 | 缺失 | 完善（ID有效性、重复检查） |
| 诊断信息 | 简陋 | 详细（ID、选项、文本等） |
| 代码可维护性 | 低 | 高 |

## 🔧 可能的进一步改进

### 如果问题仍未解决

1. **检查服务器端数据验证**
   - 某些ID可能在服务器端被标记为已删除
   - 可能存在特殊的ID范围限制
   - 可能需要的特定字段不同

2. **调查特定题目类型**
   - 匹配题的ID来源是否特殊？
   - 其他复合题目（cloze、random）是否也有问题？

3. **添加更详细的诊断**
   ```typescript
   // 打印原始 distribute 数据
   console.log('原始 subjects 结构:', JSON.stringify(getDistribute.subjects.map(s => ({
     id: s.id,
     type: s.type,
     hasSubSubjects: !!s.sub_subjects && s.sub_subjects.length > 0,
     subSubjectCount: s.sub_subjects?.length || 0,
   })), null, 2));
   ```

## 📝 总结

这个修复通过以下方式解决了问题：
1. **集中化**：将题目展开逻辑集中在一个地方
2. **透明化**：返回展开后的ID列表供调用方参考
3. **防御化**：添加充分的ID有效性检查
4. **可见化**：增强诊断日志，便于问题追踪

修复已通过 TypeScript 编译验证。建议在运行刷课时查看日志输出，确认ID列表和数量的一致性。
