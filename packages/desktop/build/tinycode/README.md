# TinyCode 产品形态图标资源

TinyCode（对外发布版身份，task #28 方案 C）的应用图标源文件与成品。由 @Dev-Frontend-mac 设计，PM 验收定稿（候选 C「括号点」：浅色渐变底 + 靛蓝 `‹ · ›`，中间方点表达 tiny）。

## 文件清单

| 文件 | 用途 |
| --- | --- |
| `icon.icns` | macOS 成品图标（10 档位 16→1024 px 含 @2x，iconutil 打包） |
| `icon.iconset/` | iconutil 中间产物（10 张 PNG，可重新打包，保证可复现） |
| `icon.svg` | 标准版源（128 px 及以上档位的渲染源） |
| `icon-32.svg` | 小尺寸简化变体源（32 / 64 px 档位：描边加粗 104、方点加大、去细边框） |
| `icon-16.svg` | 16 px 专档变体源（括号横向跨度收窄至 80，括号与方点间隙 ~1.7 px，避免粘连） |

## 尺寸 → 变体映射

| iconset 档位 | 渲染源 |
| --- | --- |
| `icon_16x16.png`（16 px） | `icon-16.svg` |
| `icon_16x16@2x.png` / `icon_32x32.png`（32 px） | `icon-32.svg` |
| `icon_32x32@2x.png`（64 px） | `icon-32.svg` |
| 其余（128 / 256 / 512 / 1024 px） | `icon.svg` |

## 重新打包 icns

```sh
iconutil -c icns icon.iconset -o icon.icns
```

## 挂接方式

electron-builder 的 TinyCode 形态打包配置（appId / 显示名 / 图标路径）在 task #28 的 productIdentity 方案落地时接线：`build.icon` 指向本目录 `icon.icns`，Windows `.ico` 待 Windows 打包时从同一 iconset 生成。
