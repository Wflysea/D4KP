# 4K 图片批量下载器 (4kdownloader)

一个用于批量下载 [4kdesk.com](https://www.4kdesk.com) 高清原图的 Windows 单文件桌面应用。
成品 `4kdownloader.exe` 体积约 **5MB**，无需安装 Python，双击即可运行。

## 功能特点

- **精准解析站点结构**：自动抓取列表页每个详情页链接，并通过「下一页」翻页（最多 124 页）。
- **下载高清原图**：从详情页提取真正的高清大图（`c.53326.com/d/file/lan...jpg`，约 54KB/张；列表缩略图仅约 34KB）。
- **两种模式**：
  - **原图模式**（默认）：访问每个详情页，画质更高。
  - **快速模式**：仅抓取列表图，速度更快。
- **多线程并发下载**：内置线程池（默认 8 线程），可随时停止。
- **本地 Web 界面**：程序启动后自动打开浏览器操作，实时显示进度与日志。

## 使用方法

1. 双击 `4kdownloader.exe`（或在 `dist/` 目录中获取），程序会自动打开浏览器界面。
2. 在界面中填写：
   - **起始列表页 URL**（默认已填 `https://www.4kdesk.com/4Kmeinv/index_2.html`）
   - **下载页数**
   - **并发线程数**
   - **保存文件夹**
3. 选择「原图模式 / 快速模式」，点击「开始下载」。
4. 「停止」可随时中止；进度与日志实时刷新。

> 提示：下载为公开壁纸资源，请设置合理的页数与线程数，避免对站点造成过大压力。
> 若要下载其它分类（如 `/4Kfengjing/`），把起始 URL 改成对应分页地址即可。

## 重新打包（可选）

如需自行构建 exe，需准备 Python 3.13 与 PyInstaller、UPX：

```bat
build.bat
```

`build.bat` 使用 PyInstaller 单文件 + `--windowed` + UPX 压缩 + `-OO` 优化，并排除大量无关模块，
将体积控制在约 5MB。关键技术点：下载走 Windows 内置 **WinHTTP**（系统组件，不打包 OpenSSL），
本地界面用极简 **raw-socket HTTP 服务** 替代 `http.server`，从而去掉 `ssl/http/email` 等重量级模块。

## 目录结构

```
4kdownloader/
├── image_downloader.py   # 完整源码（纯标准库，无第三方依赖）
├── build.bat             # 一键打包脚本
├── dist/
│   └── 4kdownloader.exe  # 成品（约 5MB）
└── README.md
```

## 说明

- 该站「下载原图」按钮需登录，本工具抓取的是详情页公开展示的高清原图。
- 仅依赖 Python 标准库；打包时不包含任何第三方包。
