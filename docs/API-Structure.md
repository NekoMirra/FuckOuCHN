# LMS API 结构文档

> 通过真实网站测试验证，更新于 2025-12-24

## 基础信息

- **API 基础URL**: `https://lms.ouchn.cn/api`
- **认证方式**: Cookie (session)
- **Content-Type**: `application/json`

---

## 课程相关 API（高效获取）

### 1. 获取我的课程列表

```http
GET /api/my-courses?conditions={"status":["ongoing"],"keyword":""}&page=1&page_size=50
```

**关键返回字段**:
- `courses[].id` - 课程 ID
- `courses[].name` - 课程名称
- `courses[].completeness` - **完成度百分比**（直接返回，无需计算！）

---

### 2. 获取课程模块列表

```http
GET /api/courses/{courseId}/modules
```

**响应示例**:
```json
{
  "modules": [
    {"id": 30001942526, "name": "模块名称", "sort": 0, "hidden": false}
  ]
}
```

---

### 3. 获取课程所有活动（高效！）

```http
GET /api/course/{courseId}/all-activities?module_ids=[id1,id2,...]&activity_types=learning_activities,exams,classrooms
```

**关键返回字段**:
- `learning_activities[]` - 学习活动列表
- `exams[]` - 考试列表（含 `activity_final_score`, `submit_times`）
- `classrooms[]` - 课堂活动列表

每个活动包含：`id`, `title`, `type`, `module_id`, `hidden`, `is_started`, `is_closed`

---

### 4. 获取课程完成度（高效！⭐推荐）

```http
GET /api/course/{courseId}/my-completeness
```

**响应示例**:
```json
{
  "completed_result": {
    "completed": {
      "exam_activity": [30003714031, 30003714038],
      "learning_activity": [30007882485, 30007883991, ...]
    },
    "total_activities": 71,
    "total_completed": 41
  },
  "study_completeness": 57.7,
  "last_activity": {...}
}
```

**优势**: 一次请求获取所有已完成活动 ID，无需遍历 DOM！

---

### 5. 获取活动阅读记录

```http
GET /api/course/{courseId}/activity-reads-for-user
```

**响应示例**:
```json
{
  "activity_reads": [
    {
      "activity_id": 30008808754,
      "activity_type": "learning_activity",
      "completeness": "full",
      "data": {"completeness": 100, "score": 75},
      "last_visited_at": "2025-12-24T13:14:52Z"
    }
  ]
}
```

**completeness 值**: `"full"` | `"part"` | `"none"`

---

## 高效获取未完成活动的推荐流程

```
1. GET /api/courses/{id}/modules → 获取 module_ids
2. GET /api/course/{id}/all-activities?module_ids=[...]&activity_types=... → 获取所有活动
3. GET /api/course/{id}/my-completeness → 获取已完成活动 ID 集合
4. 对比计算：未完成 = 所有活动 - 已完成活动
```

**性能对比**:
- DOM 遍历方式：需要页面导航 + 展开模块 + 遍历元素，耗时 5-15 秒
- API 方式：3 个并发请求，耗时 200-500ms

---

## 考试相关 API

### 1. 获取考试信息

```http
GET /api/exams/{examId}
```

**响应示例**:

```json
{
  "id": 30003642924,
  "title": "专题测验",
  "subjects_count": 17,
  "total_points": 100.0,
  "submit_times": 999,
  "submitted_times": 0,
  "is_started": true,
  "is_closed": false,
  "announce_score_status": "immediate_announce"
}
```

---

### 2. 获取题目列表

```http
GET /api/exams/{examId}/distribute
```

**响应示例**:

```json
{
  "exam_paper_instance_id": 30167346056,
  "subjects": [
    {
      "id": 30026602872,
      "type": "true_or_false",
      "description": "<p>题目内容...</p>",
      "point": "5.0",
      "last_updated_at": "2025-08-06T07:10:40Z",
      "options": [
        {"id": 30070024970, "content": "对", "sort": 0, "type": "text"},
        {"id": 30070024971, "content": "错", "sort": 1, "type": "text"}
      ]
    }
  ]
}
```

**题目类型** (`type`):

| 值 | 说明 |
|----|------|
| `text` | 纯文本（章节标题，如"一、判断题"） |
| `true_or_false` | 判断题 |
| `single_selection` | 单选题 |
| `multiple_selection` | 多选题 |
| `short_answer` | 简答题 |
| `random` | 随机抽题（sub_subjects 包含实际题目） |

---

### 3. 开始答题（存储会话）

```http
POST /api/exams/{examId}/submissions/storage
```

**请求体**:

```json
{
  "exam_paper_instance_id": 30167346056,
  "exam_submission_id": null,
  "subjects": [
    {
      "subject_id": 30026602872,
      "subject_updated_at": "2025-08-06T07:10:40Z",
      "answer_option_ids": []
    }
  ],
  "progress": {
    "answered_num": 0,
    "total_subjects": 17
  }
}
```

**响应**:

```json
{
  "id": 30170856086,
  "left_time": 1575504.310112
}
```

> ⚠️ 调用此接口会消耗一次答题机会

---

### 4. 提交答案

```http
POST /api/exams/{examId}/submissions
```

**请求体**:

```json
{
  "exam_paper_instance_id": 30167346056,
  "exam_submission_id": 30170856086,
  "reason": "user",
  "subjects": [
    {
      "subject_id": 30026602872,
      "subject_updated_at": "2025-08-06T07:10:40Z",
      "answer_option_ids": [30070024970]
    },
    {
      "subject_id": 30026603225,
      "subject_updated_at": "2025-08-06T07:10:41Z",
      "answer_option_ids": [],
      "answer_text": "简答题的答案内容"
    }
  ],
  "progress": {
    "answered_num": 17,
    "total_subjects": 17
  }
}
```

**字段说明**:

| 字段 | 类型 | 说明 |
|------|------|------|
| `answer_option_ids` | `number[]` | 选择题答案（选项ID数组） |
| `answer_text` | `string` | 简答题答案（可选，仅 short_answer 使用） |

---

### 5. 获取提交记录

```http
GET /api/exams/{examId}/submissions
```

**响应示例**:

```json
{
  "exam_score": 100.0,
  "exam_score_rule": "highest",
  "submissions": [
    {
      "id": 60092024720,
      "score": "100.0",
      "created_at": "2024-10-17T12:12:18Z",
      "submitted_at": "2024-10-17T12:13:29Z"
    }
  ]
}
```

---

### 6. 获取单次提交详情

```http
GET /api/exams/{examId}/submissions/{submissionId}
```

用于获取历史答案，用于排除已知错误选项。

---

## 题目概要 API

```http
GET /api/exams/{examId}/subjects-summary?forAllSubjects=true
```

**响应示例**:

```json
{
  "subjects": [
    {"id": 30026602872, "type": "true_or_false", "point": "5.0", "has_audio": false},
    {"id": 30026603291, "type": "single_selection", "point": "5.0", "has_audio": false}
  ]
}
```

---

## 错误码

| HTTP 状态码 | 说明 |
|-------------|------|
| 200 | 成功 |
| 201 | 创建成功 |
| 400 | 请求参数错误 / Cookie 验证失败 |
| 404 | 资源不存在（如首次开始考试时 storage 不存在） |
| 429 | 请求过于频繁 |

---

## 代码映射

| API 端点 | 代码文件 | 方法 |
|----------|----------|------|
| `GET /exams/{id}` | `Exam.ts` | `get()` |
| `GET /exams/{id}/distribute` | `Exam.ts` | `getDistribute()` |
| `POST /exams/{id}/submissions/storage` | `Exam.ts` | `submissionsStorage()` |
| `POST /exams/{id}/submissions` | `Exam.ts` | `postSubmissions()` |
| `GET /exams/{id}/submissions` | `Exam.ts` | `getSubmissions()` |
| `GET /exams/{id}/submissions/{sid}` | `Exam.ts` | `getSubmission()` |
