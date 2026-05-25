# SuperStudio

> 一站式 AI 工作站桌面应用 —— 对话、生图、视频、知识库、工作流、AI 编程一个 Electron 应用搞定。

SuperStudio 把 LLM 对话 + 多模态生成（文生图、图生图、文生视频、视觉理解）+ 本地知识库 + 可视化工作流 + AI 辅助代码工程，统一在一个跨平台桌面应用里。所有数据（对话、画廊、向量库）都存在本地，可控、可备份。

通过内置的 **SuperCode 账号体系**一键开通 Anthropic / OpenAI 等多平台模型访问，无需自己折腾各家 API Key。

---

## ✨ 主要功能

### 🤖 Agent 对话 (Chat)
- **多提供商**：内置 SuperCode 一键开通 Anthropic + OpenAI 等平台；也支持手动配置 OpenAI 协议的任意代理
- **完整工具循环**：联网搜索、文生图、文生视频、视觉理解、Office 文件读写、画廊保存
- **流式渲染** + `<think>` 思考过程独立折叠
- **完整 Markdown** (react-markdown + remark-gfm)，代码块独立复制
- **会话级模型切换**、知识库挂载、图片参数调节
- **会话列表按日期聚合**（今天 / 昨天 / 7 天 / 30 天 / 更早），支持自定义日期范围
- **自动模型路由**（可选）：根据问题类型自动选用最合适的模型

### 📊 仪表盘 (Dashboard)
- 账户余额、今日请求数、今日消耗、今日 Token、平均缓存率
- Token 使用趋势 + 消费趋势折线图（recharts）
- 每日明细列表
- 按 API Key 消费分布
- 自定义日期筛选（今日 / 近 7 天 / 近 30 天 / 自定义）

### 🛠 AI 编程「构建」(Vibe / Build)
**OpenSpec 思想驱动的 spec-driven 编程工作流**：
- 打开本地项目或新建项目（支持应用管理 + 自定义路径双模式）
- 描述需求 → AI 自动**拆解成结构化任务列表**让你审 → 一键执行
- 实时显示**工作过程**：每个任务的工具调用、文件读写、推理文本
- 文档化产出 `openspec/changes/<slug>/proposal.md + tasks.md`（git 可跟踪）
- VS Code 风**多 tab 编辑器**（Monaco，全语法高亮 + Ctrl+S）
- **文件树 + 右键菜单**（在文件管理器中显示 / 复制路径）
- **可选浏览器预览面板**（默认隐藏，右上 toggle）
- 项目级模型选择器
- 6 个项目作用域工具：`code_read` / `code_write` / `code_edit` / `code_glob` / `code_grep` / `code_bash`

### 🎨 图片生成与编辑
- 文生图 / 图生图（参考图）/ 多张参考图
- 内置图片编辑器：
  - **局部修改** — 画笔涂抹遮罩 + 文字描述
  - **AI 扩图** — 多种比例预设（1:1 / 4:3 / 16:9 / 9:16），保留原图像素级保真
  - **无痕改字** — 替换文字保持字体风格
  - **一键抠图** — 透明背景输出
- 客户端 alpha 合成确保结果完整不透明

### 🎬 视频生成
- 文生视频 / 图生视频
- 异步任务轮询 + 进度展示
- 自动保存到画廊

### 📚 知识库
- 多空间管理（每个空间可独立启用为全局上下文）
- Markdown 页面编辑器，1.5s 防抖自动保存 + 自动向量化
- 文件导入（PDF / DOCX / TXT / MD）
- 语义搜索 + 跳转到来源页 + 高亮命中片段
- 一键重建索引（换 Embedding 模型时使用）
- 基于 LanceDB 本地向量存储

### 🔁 工作流编排 (Workflow)
- 基于 React Flow 的节点画布
- 节点类型：文本输入、变量、LLM、图片生成、视频生成、网络搜索、文件读写、画廊保存、输出
- 端口类型校验（连接时强制类型匹配）
- 5 个内置模板（文章配图流 / 网络调研流 / 图文短视频流 / 数据分析流 / 多语言内容流）
- 一键从聊天记录生成工作流

### 🖼 画廊
- 图片 / 视频统一管理
- 按时间分组（今天 / 昨天 / 本周 / 更早）
- 大图浏览：键盘左右翻页、复制、另存为、在文件夹中显示
- **一键作为参考图** —— 直接送到聊天框继续创作

### 📅 定时任务
- 到点自动跑一段 prompt，结果写进专属对话
- 每天 / 每周（多选日）/ 每月（指定日）三种触发方式 + 24 小时制时间
- 4 个开箱即用模板：每日早报 / 工作日计划 / 每晚复盘 / 月度回顾
- 连续失败 5 次自动暂停 + 桌面通知
- 应用关闭时错过的任务：< 24h 启动时补跑一次，> 24h 直接跳过

### 🔌 MCP (Model Context Protocol) 支持
接入任意外部工具服务器，与 Claude Code / Cursor / OpenCode 协议互通：
- 支持 stdio（本地子进程）和 SSE（远程 HTTP 端点）两种传输
- 内置 Minimax 预设（一键填入 `web_search` / `understand_image`）
- 连接测试 + 工具列表预览
- Agent 启动时自动拉取所有启用服务器的工具并合并

### 📄 办公文件
- 解析 XLSX / DOCX / PPTX / PDF / TXT / MD
- XLSX 写回（set_cell / set_range / copy_column 三种操作）
- 写入前自动备份到 `.backup/`，附带还原按钮
- 30 天前的备份启动时自动清理

---

## 🧱 技术栈

| 层 | 技术 |
|----|------|
| 桌面壳 | Electron 33 + electron-vite |
| 渲染层 | React 18 + TypeScript + Tailwind CSS |
| LLM 集成 | Vercel AI SDK + @ai-sdk/* |
| 代码编辑器 | Monaco Editor (VS Code 同款) |
| 状态 | Zustand |
| 关系数据 | sql.js (SQLite WASM) |
| 向量数据 | @lancedb/lancedb |
| 工作流画布 | @xyflow/react |
| 图表 | recharts |
| Markdown | react-markdown + remark-gfm |
| 配置存储 | electron-store + safeStorage (OS keychain 加密) |
| 文档解析 | xlsx / mammoth / pdfjs-dist / pptxgenjs |
| MCP 客户端 | @modelcontextprotocol/sdk |

---

## 🚀 快速开始

### 先决条件
- **Node.js 18+**
- 一个 **SuperCode 账号**（推荐，最简）：访问 [supercode.help](https://www.supercode.help) 注册
- 或者自备 OpenAI 协议兼容的 API Key

### 安装与运行

```bash
git clone https://github.com/Leon-OvO/SuperStudio.git
cd SuperStudio
npm install
npm run dev
```

### 打包发布

```bash
# Windows
npm run dist:win

# macOS
npm run dist:mac
```

构建产物在 `release/` 目录。

---

## 🎯 首次使用流程

启动后 **三步开始**：

### 方式 A：使用 SuperCode 账号（推荐）
1. **登录页输入邮箱密码** —— 默认勾选「记住密码」用于 token 过期时自动续期
2. 应用自动初始化：拉取你账号下所有平台（Anthropic / OpenAI）的 API Key，自动获取每个 Key 的模型列表
3. 直接开用！默认模型已经选好

### 方式 B：手动配置
1. 完成 SuperCode 登录后（用任意邮箱）
2. **右上角头像 → 账号 · API Keys** 也可手动新建 Key 切换平台
3. **设置 → 模型** 选定默认对话 / 图片 / 视频 / Embedding 模型

### 可选配置
- **设置 → 网络搜索**：填 Tavily 或 Serper 的 API Key 启用 `web_search` 工具
- **设置 → MCP 服务器**：接入 Minimax 等外部 MCP 工具
- **设置 → 自动切换模型**：开启智能路由

---

## 🗂 页面导航

| 入口 | 内容 |
|---|---|
| 💬 **对话** (Ctrl+1) | 主聊天界面 + 工具调用 |
| 🛠 **构建** (Ctrl+2) | OpenSpec 风 AI 编程工作流 |
| ⚡ **工作流** (Ctrl+3) | 节点式可视化编排 |
| 🖼 **画廊** (Ctrl+4) | 生成内容统一管理 |
| 📚 **知识库** (Ctrl+5) | 多空间向量化知识库 |
| ✨ **技能** (Ctrl+6) | 提示词 + 工具白名单技能包 |
| 📅 **定时** (Ctrl+7) | 到点自动跑 prompt 的定时任务 |
| 📊 **仪表盘** (Ctrl+0) | 用量统计（也在右上角头像里） |
| ⚙ **设置** | 账号 / 模型 / 网络搜索 / 知识库 / MCP / 关于 |

**右上角头像 popover**：账号信息、余额、跳转仪表盘、退出登录。

---

## 📁 项目结构

```
superstudio/
├── electron/
│   ├── main/                  # 主进程
│   │   ├── agent/             # Agent 执行引擎 + 工作流引擎
│   │   ├── ipc/               # 各模块的 IPC handler
│   │   │   ├── auth.ts        # SuperCode 账号、多 Key 管理
│   │   │   ├── dashboard.ts   # 仪表盘统计接口
│   │   │   ├── vibe.ts        # 「构建」页 propose/apply + 代码工具
│   │   │   └── ...
│   │   ├── services/          # LLM / 图片 / 视频 / 知识库 / MCP / Vibe DB 等
│   │   └── db/                # SQLite 初始化与查询
│   └── preload/               # 渲染进程能用的安全 API 桥
├── src/
│   ├── renderer/src/
│   │   ├── pages/
│   │   │   ├── Chat/          # 对话
│   │   │   ├── Vibe/          # 「构建」AI 编程
│   │   │   ├── Workflow/      # 工作流编排
│   │   │   ├── Gallery/       # 画廊
│   │   │   ├── Knowledge/     # 知识库
│   │   │   ├── Dashboard/     # 仪表盘
│   │   │   ├── Login/         # 登录
│   │   │   └── Settings/      # 设置
│   │   ├── components/        # 可复用 UI（含右上角 TopBarUser）
│   │   ├── stores/            # Zustand 状态
│   │   └── lib/               # 工具函数
│   └── shared/                # 主进程与渲染层共享的类型 + IPC 通道常量
└── scripts/                   # 开发脚手架
```

---

## 💾 数据存储位置

| 数据 | 位置 |
|------|------|
| 凭据 / API Keys（加密） | electron-store + OS keychain (`<userData>/auth.json`) |
| 对话 / 画廊 / 工作流 / 构建任务元数据 | `<userData>/superstudio.db` |
| 生成的图片 | `<userData>/gallery/images/` |
| 生成的视频 | `<userData>/gallery/videos/` |
| 向量索引 | `<userData>/lancedb/` |
| 构建页托管项目 | `<userData>/vibe-projects/` |
| 错误日志 | `<userData>/logs/app.log.jsonl`（最近 500 条） |
| 文件备份 | `<userData>/.backup/` |

可在 **设置 → 模型 → 数据目录** 自定义存储路径。

`<userData>` 在不同系统下：
- Windows: `%APPDATA%\superstudio\`
- macOS: `~/Library/Application Support/superstudio/`
- Linux: `~/.config/superstudio/`

---

## 🛠 开发命令

```bash
npm run dev               # 启动开发模式（热重载）
npm run build             # 构建生产产物到 out/
npm run typecheck:web     # 类型检查渲染层
npm run typecheck:node    # 类型检查主进程
npm run dist:win          # 打包 Windows (.exe / portable)
npm run dist:mac          # 打包 macOS (.dmg / .zip)
```

---

## 🔒 隐私与数据

- 所有 API Key 通过操作系统的 keychain 加密存储（macOS Keychain / Windows Credential Manager / Linux secret-service）
- 对话历史、画廊文件、向量库 **100% 本地**，不上报任何服务器
- 错误日志只写本地磁盘 (`<userData>/logs/`)，**不上传**
- SuperCode 账号体系本身的数据流向：仅在调用 supercode.help 接口时发生（登录、获取 Key、调用模型、查统计），其余交互全在本地

---

## 📦 备份与迁移

- **设置 → 关于 → 数据备份**：一键导出所有本地配置（提供商、默认模型、MCP 服务器、应用设置）为 .json 文件
- **设置 → 关于 → 对话备份**：单独导出所有会话和消息内容
- 换电脑或重装时导入这两个文件即可恢复
- API Key 用机器密钥加密，跨机器需要重新填写
- 画廊图片 / 视频文件需用「画廊 → 批量保存到文件夹」单独备份

---

## 🤝 鸣谢

- [Vercel AI SDK](https://github.com/vercel/ai)
- [LanceDB](https://github.com/lancedb/lancedb)
- [React Flow / xyflow](https://github.com/xyflow/xyflow)
- [Monaco Editor](https://github.com/microsoft/monaco-editor)
- [Model Context Protocol](https://modelcontextprotocol.io/)
- [electron-vite](https://electron-vite.org/)
- [recharts](https://recharts.org/)
- 设计灵感参考 [Qoder](https://qoder.com/) 的右上角账号面板、[OpenSpec](https://github.com/Fission-AI/OpenSpec) 的 spec-driven 工作流

---

## 📜 许可证

MIT
