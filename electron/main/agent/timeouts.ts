/**
 * Agent 侧时长上限的唯一真相源。
 *
 * 这个文件存在的理由：同一个 MCP 服务器有两条到达路径 —— 进程内引擎
 * （services/mcp.ts）与外部 CLI 运行时（worker/runtime/*）。两边原本各自
 * 抄了一份常量，然后漂移了：一次实测 178s 的出图工具走 CLI（300s）能成功，
 * 走内置引擎（120s）却被掐断。凡是「一个工具最长可以合法地干多久」这类
 * 上限，都放在这里，别再在调用点写字面量。
 */

/** MCP 首次握手。要够 `uvx` / `uv run --with` 冷启动并解析依赖。 */
export const MCP_CONNECT_TIMEOUT_MS = 30_000

/** 列工具只是一次廉价的元数据往返，不该等这么久。 */
export const MCP_LIST_TOOLS_TIMEOUT_MS = 10_000

/**
 * 执行一个工具。出图/出视频合法地要跑好几分钟，所以这里故意放得很长：
 * 生图自身上限就是 180s，任何低于它的上限都会把正常工作判成超时。
 * 取消是 abort signal 的职责，不是超时的职责 —— 卡住的服务器该由用户打断，
 * 而不是被悄悄地在渲染中途切掉。
 */
export const MCP_TOOL_CALL_TIMEOUT_MS = 300_000
