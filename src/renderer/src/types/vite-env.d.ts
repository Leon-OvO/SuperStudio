/// <reference types="vite/client" />

// 渲染层用到了 Vite 的 `?worker` 导入后缀（见 pages/Vibe/Editor/setup.ts 的 monaco worker）。
// 这些是 Vite 在打包期合成的虚拟模块，tsc 单独跑时不认识，必须靠这条 reference 引入
// vite/client 的模块声明，否则 `tsc --noEmit -p tsconfig.web.json` 会报 TS2307。
