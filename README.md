# SuperStudio

> 一站式 AI 生产力桌面应用 —— 对话、生图、视频、知识库、工作流、画廊全在一个本地 Electron 应用里。

SuperStudio 把多家大模型（OpenAI / Anthropic / Gemini / 任意 OpenAI 兼容协议代理）+ 多模态能力（文生图、图生图、文生视频、视觉理解）+ 本地知识库 + 可视化工作流编排，统一在一个跨平台桌面应用里。所有数据（对话、画廊、向量库）都存在本地，可控、可备份。

## 主要功能

### Agent 对话
- 多提供商支持（OpenAI / Anthropic / Gemini / 任意 OpenAI 兼容代理）
- 工具调用循环：联网搜索、图片生成、视频生成、视觉理解、文件读写、画廊保存
- 流式渲染，支持 `<think>` 思考过程独立折叠显示
- 完整 Markdown 渲染（基于 react-markdown + remark-gfm），代码块独立复制
- 长消息自动收起 + 一键复制
- 会话级模型切换、知识库挂载、图片参数调节
- 会话列表按日期聚合（今天 / 昨天 / 过去 7 天 / 过去 30 天 / 更早），支持快捷范围 + 自定义日期范围筛选

### 图片生成与编辑
- 文生图 / 图生图（参考图）/ 多张参考图
- 内置图片编辑器：
  - **局部修改** —— 画笔涂抹遮罩 + 文字描述
  - **AI 扩图** —— 多种比例预设（1:1 / 4:3 / 16:9 / 9:16 等），保留原图像素级保真
  - **无痕改字** —— 替换文字保持字体风格一致
  - **一键抠图** —— 透明背景输出
- 客户端 alpha 合成确保结果完整不透明

### 视频生成
- 文生视频 / 图生视频
- 异步任务轮询 + 进度展示
- 自动保存到画廊

### 知识库
- 多空间管理（每个空间可独立启用为全局上下文）
- Markdown 页面编辑器，1.5s 防抖自动保存 + 自动向量化
- 文件导入（PDF / DOCX / TXT / MD）
- 语义搜索 + 结果跳转到来源页 + 高亮命中片段
- 一键重建索引（换 Embedding 模型时使用）
- 基于 LanceDB 本地向量存储

### 工作流编排
- 基于 React Flow 的节点画布
- 节点类型：文本输入、变量、LLM、图片生成、视频生成、网络搜索、文件读写、画廊保存、输出
- 端口类型校验（连接时强制类型匹配）
- 节点间数据自动传递
- 5 个内置模板（文章配图流 / 网络调研流 / 图文短视频流 / 数据分析流 / 多语言内容流）
- 一键从聊天记录生成工作流

### 画廊
- 图片 / 视频统一管理
- 按时间分组（今天 / 昨天 / 本周 / 更早）
- 大图浏览：键盘左右翻页、复制、另存为、在文件夹中显示
- 右键菜单：复制、另存为、在画廊预览
- **一键作为参考图** —— 直接送到聊天框继续创作

### MCP（Model Context Protocol）支持
通过 MCP 协议接入任意外部工具服务器，与 Claude Code / Cursor / OpenCode 协议互通：
- 支持 stdio（本地子进程启动）和 SSE（远程 HTTP 端点）两种传输
- 内置 Minimax 预设（一键填入 `web_search` / `understand_image`）
- 连接测试 + 工具列表预览
- Agent 启动时自动拉取所有启用服务器的工具并合并到工具集

### 办公文件
- 解析 XLSX / DOCX / PPTX / PDF / TXT / MD
- XLSX 写回（set_cell / set_range / copy_column 三种操作）
- 写入前自动备份到 `.backup/`，附带还原按钮
- 30 天前的备份启动时自动清理

## 技术栈

| 层 | 技术 |
|----|------|
| 桌面壳 | Electron 33 + electron-vite |
| 渲染层 | React 18 + TypeScript + Tailwind CSS |
| LLM 集成 | Vercel AI SDK + @ai-sdk/* |
| 状态 | Zustand |
| 关系数据 | sql.js (SQLite WASM) |
| 向量数据 | @lancedb/lancedb |
| 工作流画布 | @xyflow/react |
| Markdown | react-markdown + remark-gfm |
| 配置存储 | electron-store (加密) |
| 文档解析 | xlsx / mammoth / pdfjs-dist / pptxgenjs |
| MCP 客户端 | @modelcontextprotocol/sdk |

## 快速开始

### 先决条件
- Node.js 18+
- 任一兼容 OpenAI 协议的 API 服务（OpenAI / Anthropic / Gemini / Azure / 中转代理 / 本地模型 等）

### 安装与运行

```bash
git clone https://gitee.com/leonops/SuperStudio.git
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

## 首次使用配置

1. 启动后进入 **设置 → 提供商**，添加至少一个 LLM 提供商
   - 填写 API Key
   - 可点「拉取列表」自动获取该提供商的模型列表，也可手动添加模型 ID
2. 进入 **设置 → 默认模型**，分别为对话 / 图片 / 视频 / Embedding 选定默认模型
3. （可选）**设置 → 网络搜索**：配置 Tavily 或 Serper 的 API Key
4. （可选）**设置 → MCP 服务器**：接入 Minimax 等外部 MCP 工具
5. 回到「对话」开始使用

## 项目结构

```
superstudio/
├── electron/
│   ├── main/                  # 主进程：IPC、数据库、AI 服务、MCP 客户端
│   │   ├── agent/             # Agent 执行引擎 + 工作流引擎
│   │   ├── ipc/               # 各模块的 IPC handler
│   │   ├── services/          # LLM / 图片 / 视频 / 文件 / 知识库 / MCP 等
│   │   └── db/                # SQLite 初始化与查询
│   └── preload/               # 渲染进程能用的安全 API 桥
├── src/
│   ├── renderer/src/
│   │   ├── pages/             # 5 大页面：Chat / Workflow / Gallery / Knowledge / Settings
│   │   ├── components/ui/     # 可复用基础组件（Select / Dialog / ContextMenu / ImageEditor 等）
│   │   ├── stores/            # Zustand 状态
│   │   └── lib/               # 工具函数（Markdown / 剪贴板 / 日期等）
│   └── shared/                # 主进程与渲染层共享的类型 + IPC 通道常量
└── scripts/                   # 开发脚手架
```

## 数据存储位置

| 数据 | 位置 |
|------|------|
| 配置 / API Keys（加密） | electron-store（操作系统 userData 目录） |
| 对话 / 画廊 / 工作流元数据 | `<userData>/superstudio.db` |
| 生成的图片 | `<userData>/gallery/images/` |
| 生成的视频 | `<userData>/gallery/videos/` |
| 向量索引 | `<userData>/lancedb/` |
| 文件备份 | `<userData>/.backup/` |

可在 **设置 → 默认模型 → 数据目录** 自定义存储路径。

## 开发命令

```bash
npm run dev               # 启动开发模式（热重载）
npm run build             # 构建生产产物到 out/
npm run typecheck:web     # 类型检查渲染层
npm run typecheck:node    # 类型检查主进程
npm run dist:win          # 打包 Windows 安装包 (.exe / portable)
npm run dist:mac          # 打包 macOS (.dmg / .zip)
```

## 鸣谢

- [Vercel AI SDK](https://github.com/vercel/ai)
- [LanceDB](https://github.com/lancedb/lancedb)
- [React Flow / xyflow](https://github.com/xyflow/xyflow)
- [Model Context Protocol](https://modelcontextprotocol.io/)
- [electron-vite](https://electron-vite.org/)

## 许可证

MIT
