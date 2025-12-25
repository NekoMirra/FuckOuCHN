# FuckOuCHN

> 国开自动刷课程序 - 基于 Node.js、Electron 和 Playwright

一款自动化刷课工具，支持视频播放、自动答题、并发处理等功能。

## ✨ 功能特性

- 🎬 **视频自动播放** - 支持倍速播放（最高 16 倍速）
- 📝 **AI 自动答题** - 支持单选、多选、判断、简答等题型
- 🚀 **并发刷课** - 多窗口并行处理，效率翻倍
- 📊 **进度面板** - 实时显示刷课进度
- 🛡️ **风控检测** - 自动检测账号封禁状态
- 📄 **PDF 自动浏览** - 自动滚动资料页面

## 📦 快速开始

### 方式一：下载可执行文件（推荐）

直接下载打包好的程序，无需安装任何依赖：

👉 [下载 FuckOuCHN.exe](https://github.com/NekoMirra/FuckOuCHN/releases/latest)

### 方式二：从源码运行

#### 1. 环境准备

- 安装 [Node.js](https://nodejs.org/zh-cn) (v18+)
- 安装 [Yarn](https://yarnpkg.com/)

```bash
npm install -g yarn --registry=https://registry.npmmirror.com
```

#### 2. 克隆项目

```bash
git clone https://github.com/NekoMirra/FuckOuCHN.git
cd FuckOuCHN
```

#### 3. 配置账号

```bash
# 复制配置模板
cp .env.template .env

# 编辑 .env 文件，填写你的账号和密码
```

#### 4. 安装依赖

```bash
yarn config set registry https://registry.npmmirror.com
yarn install
```

#### 5. 启动程序

```bash
yarn start:electron
```

## ⚙️ 配置说明

编辑 `.env` 文件进行配置：

### 必填配置

```properties
_ACCOUNT="你的账号"
_PASSWORD="你的密码"
```

### 功能开关

| 配置项 | 说明 | 默认值 |
|--------|------|--------|
| `_ENABLE_VIDEO` | 视频刷课开关（1=开启，0=关闭） | 1 |
| `_ENABLE_EXAM` | 自动答题开关（1=开启，0=关闭） | 1 |
| `_PLAY_RATE` | 视频播放倍速 | 8 |
| `_TOTAL_POINTS` | 考试及格分数，达到后自动结束 | 60 |

### AI 答题配置

```properties
_API="https://api.openai.com/v1"  # API 接口地址
_KEY="your-api-key"                # API 密钥
_MODEL="gpt-4o-mini"               # 模型名称
_Qps=1                             # 每秒请求数
```

### 并发配置

| 配置项 | 说明 | 默认值 |
|--------|------|--------|
| `_CONCURRENCY` | 并发窗口数（0=自动，1-6=固定） | 1 |
| `_SHOW_WORKERS` | 显示所有窗口（0=只显示主窗口） | 0 |
| `_UI_TOPMOST` | 进度面板置顶 | 1 |

### 课程选择

```properties
# 选择特定课程组
_GROUP_INDEX=0          # 0=全部，1-N=指定序号
_GROUP_TITLE=英语       # 按标题模糊匹配

# 执行策略
_LOWEST_N=10            # 只处理进度最低的 N 个课程
_NON_INTERACTIVE=1      # 非交互模式
```

完整配置请参考 [.env.template](.env.template)

## ⚠️ 注意事项

1. **人机验证** - 登录时可能需要手动完成验证
2. **避免操作** - 程序运行时请勿操作浏览器窗口
3. **风控提示** - 如果账号被检测到异常，会自动暂停并提示
4. **合理使用** - 建议设置合理的并发数和倍速，避免触发风控

## 🔨 开发相关

### 本地开发

```bash
# 编译 TypeScript
yarn build

# 启动程序
yarn start:electron
```

### 打包发布

```bash
# 设置 Electron 镜像（可选）
$env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"

# 打包
yarn build:electron
```

### 代码格式化

```bash
npx prettier --write ./src ./core/src
```

## 📄 License

[MIT](LICENSE)

## 🙏 致谢

本项目基于 [ImsTech](https://github.com/2468785842/ImsTech) 二次开发
