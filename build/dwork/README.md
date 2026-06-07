# DWork brand assets (placeholders)

These icons are **placeholders** — currently copies of the SuperStudio icons so
that `npm run dist:dwork:win` runs end-to-end during scaffolding.

Replace with the real DWork brand assets before any DWork release (tasks 5.3):

| File         | Used by                                   | Status      |
| ------------ | ----------------------------------------- | ----------- |
| `icon.ico`   | Windows app + NSIS/portable installer     | placeholder |
| `icon.png`   | docs / build preview                      | placeholder |
| `icon.icns`  | macOS app/dmg (`dist:dwork:mac`)          | **missing** |
| `tray.png`   | system tray (if a DWork tray is wired)    | **missing** |

`icon.icns` is intentionally absent (matches the SuperStudio `build/` which also
lacks `.icns`); `dist:dwork:mac` needs it generated before it can package.
