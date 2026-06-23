---
name: build-package
description: 本地打包 SuperStudio 与 DWork 的 Windows / macOS 安装包。覆盖 flavor 隔离、产物校验、版本号来源、以及在 Windows 上无法本地打 Mac 时走 CI 的方案。用户说「打包 / 出安装包 / 重新打包 / repackage / build installer / 打 win / 打 mac」时用。
---

# 本地打包 SuperStudio / DWork

两个 flavor 共用同一套源码,靠构建期 `FLAVOR` 环境变量区分:
- **SuperStudio**(默认,hosted)——版本号在 `package.json` `version`。
- **DWork**(`FLAVOR=dwork`,byok 私有交付)——版本号在 `electron-builder.dwork.yml` 的 `extraMetadata.version`,独立于 SuperStudio。

产物统一落在 `dist/`,文件名带各自 productName:`SuperStudio-X.Y.Z-Setup.exe` / `DWork-X.Y.Z-Setup.exe`(+ `-Portable.exe`;Mac 为 `.dmg` / `.zip`)。

## 前置条件
- `sources/`(~840 人才 .md)在本地存在 → `pack-talent.mjs` 才会把人才市场打进 `resources/talent-pool.enc`。**CI / clean checkout 没有 `sources/` 时 pack-talent 静默跳过,沿用已提交的 `.enc`**;本地有 `sources/` 才会重新打包。
- `node` + 已 `npm i`。`build/icon.png`(1024²)存在;Mac 还需由它生成 `build/icon.icns`(见下)。
- 不签名(`signHook=false`),产出未签名包,安装时系统会有安全提示——预期行为。

---

## ⚠️ 第一铁律:flavor 隔离(打两个 flavor 必看)

SuperStudio 与 DWork **共用 `out/`**(electron-vite 的中间产物)。**同批 / 并行构建会污染 DWork 包 → 被烤成 superstudio flavor**(更新指向错误的渠道)。

**必须:每个 flavor 单独 `rm -rf out` 后再打,绝不并行。**

```bash
# 顺序打两个 win 包:
taskkill //F //IM esbuild.exe 2>/dev/null; rm -rf out
npm run dist:win            # → dist/SuperStudio-X.Y.Z-{Setup,Portable}.exe

taskkill //F //IM esbuild.exe 2>/dev/null; rm -rf out   # ← 隔离!
npm run dist:dwork:win      # → dist/DWork-X.Y.Z-{Setup,Portable}.exe
```

### 打完必须校验 flavor(防污染)
`registerProprietaryProviders` 由 `if (FLAVOR === 'superstudio')` 门控,通过动态 `import('./services/providers/register-proprietary')` 加载。所以构建后看 `out/main`:

```bash
# SuperStudio 应有专有分块 + 调用:
grep -c registerProprietaryProviders out/main/index.js   # > 0
ls out/main/ | grep -i propriet                          # register-proprietary-*.js 存在

# DWork 应【没有】(死分支被 tree-shake):
grep -c registerProprietaryProviders out/main/index.js   # = 0
ls out/main/ | grep -i propriet                          # 无 → 正确 dwork flavor
```

注:`out/main/index.js` 里 `"superstudio"` 和 `"dwork"` 两个字面量在**任何** flavor 都存在(它们在比较逻辑里),所以**别**用字面量判 flavor;真正判据是上面的「专有分块/调用是否存活」。

### DWork 还要确认人才库随包
```bash
ls -la dist/win-unpacked/resources/talent-pool.enc   # ~11MB,付费交付物必须在包里
```
`talent-pool.enc` 是客户已购买的付费交付物,DWork 包必须含它(`electron-builder.dwork.yml` 的 extraResources)。

---

## Windows 单独打某一个

```bash
taskkill //F //IM esbuild.exe 2>/dev/null; rm -rf out
npm run dist:win          # SuperStudio
# 或
npm run dist:dwork:win    # DWork
```

`dist:win` = `npm run build`(pack-talent + electron-vite build)+ `electron-builder --win`。
`dist:dwork:win` = `npm run build:dwork`(pack-talent + `FLAVOR=dwork` electron-vite build)+ `electron-builder --win --config electron-builder.dwork.yml`。

---

## macOS 打包

### 在 macOS 上(本地能打)
先用系统 `iconutil` 由 `build/icon.png` 生成 `build/icon.icns`(仓库只提交 png,不提交 icns):
```bash
rm -rf icon.iconset && mkdir -p icon.iconset
for s in 16 32 128 256 512; do
  sips -z $s $s              build/icon.png --out "icon.iconset/icon_${s}x${s}.png"
  sips -z $((s*2)) $((s*2))  build/icon.png --out "icon.iconset/icon_${s}x${s}@2x.png"
done
iconutil -c icns icon.iconset -o build/icon.icns

# 隔离同 win:
rm -rf out && npm run dist:mac          # SuperStudio → dist/*.dmg + *.zip (x64+arm64)
rm -rf out && npm run dist:dwork:mac    # DWork
```
`NODE_OPTIONS=--max-old-space-size=8192`(monaco + 全语言模式会爆默认 ~2GB V8 堆)。

### 在 Windows 上(打不了 Mac,走 CI)
**Windows 无法生成 `.dmg`**(需 macOS 的 `hdiutil`/`iconutil`)。用 GitHub Actions:

- **`.github/workflows/mac-build.yml`**(手动 `workflow_dispatch`,macos runner,**仅 SuperStudio**,x64+arm64 dmg+zip):
  ```bash
  gh workflow run mac-build.yml --repo xizim/SuperStudio --ref master
  gh run watch <run-id> --repo xizim/SuperStudio
  gh run download <run-id> --repo xizim/SuperStudio --name superstudio-mac --dir dist-mac
  ```
- **没有 DWork Mac job**——要打 DWork Mac 得给 CI 加一个 `FLAVOR=dwork` 的 job。
- **`release.yml`(push tag v*)的自动发布会失败**:`package.json` 的 `build.publish` 指向 `Leon-OvO`,而 CI 用 xizim 的 GITHUB_TOKEN 跨 owner 写不进去。正式 release 是**手动 web UI**(见 release-host 流程)。
- **⚠️ artifact 存储配额坑**:mac-build 编译成功但 Upload 可能报 `Artifact storage quota has been hit`;删旧 artifact 后**重算滞后 6–12h**,当时不一定生效。绕开法:等重算后重跑,或给 mac-build 加一步把 dmg/zip 挂到 xizim 的 Release。
- CI(`ci.yml`)长期 fail = `typecheck:web` 那 5 条 monaco `?worker` 噪声,**不影响** mac-build / electron-builder(它们不跑 typecheck:web)。

---

## 版本号

- **不改版本**:直接打,产物用现有版本号(SuperStudio `package.json`、DWork `electron-builder.dwork.yml` extraMetadata.version)。
- **要 +1**:改对应文件的版本号;DWork 交付仓同步时还要改 `scripts/make-split.mjs` 的 `pkg.version`。

---

## 产物清单(打完应有)
```
dist/SuperStudio-X.Y.Z-Setup.exe       # NSIS 安装版
dist/SuperStudio-X.Y.Z-Portable.exe    # 免安装版
dist/DWork-X.Y.Z-Setup.exe
dist/DWork-X.Y.Z-Portable.exe
# Mac(本地或 CI):dist/*.dmg  dist/*.zip  dist/latest-mac.yml
```

## 常见坑速查
- 打 DWork 前忘了 `rm -rf out` → DWork 被烤成 superstudio flavor(校验 `registerProprietaryProviders` 会 > 0)。
- `electron-builder` 需 `package.json` 里 `"npmRebuild": false`(node-pty Electron33 prebuild)。
- pack-talent 在没有 `sources/` 时跳过 → 人才市场为空(本地打记得有 `sources/`)。
- `taskkill //F //IM esbuild.exe` 先杀残留 esbuild,免得 `rm -rf out` 在 Windows 上被占用锁住。
