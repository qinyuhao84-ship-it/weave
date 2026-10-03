# macOS 桌面预览安装包复验（发布前历史记录）

本文保留 v0.2.2 发布前、内部版本号仍为 0.2.0 的安装验收结果；当前安装包见 [v0.2.2 验收](release-validation-2026-10-03.md)。当时保留现有源码与版本号，使用 `dist/quality-2026-10-03/` 生成独立预览产物。没有 Developer ID Application 私钥，本次跳过正式签名与公证；包内清单会记录 `preview-ad-hoc`，GitHub 的包构建继续使用同样的无凭据模式。

## 可重复验收

```bash
WEAVE_DESKTOP_OUTPUT_DIR=dist/quality-2026-10-03 pnpm package:mac
pnpm verify:desktop -- dist/quality-2026-10-03/Weave-0.2.0-macOS-arm64.dmg
```

`verify:desktop` 先校验 DMG 与构建清单，再只读挂载并复制到临时独立目录。完整模式直接启动复制后的 `织识.app/Contents/MacOS/Weave`，通过其 Cocoa 单实例逻辑检查重复启动，然后用包内服务导入 Markdown 和 CJK PDF、执行全文检索、本地模拟问答与引用校验，重启后检查保存状态，确认应用、启动器和服务进程停止，并逐文件哈希比较包含 `.weave` 与 `.git` 的完整知识库备份。验收使用隔离知识库、隔离配置、本地模拟模型和 `/usr/bin:/bin` 初始 PATH，不读取个人知识库或真实模型凭据。

复核原生窗口、菜单与快捷键时可加 `--keep-open`；完整数据验收结束后，脚本会输出独立安装副本与临时知识库路径并保持窗口打开。向验收进程发送 SIGINT 或 SIGTERM 后，脚本会关闭应用并删除自己创建的临时目录。

GitHub macOS workflow 使用 `pnpm verify:desktop -- --service-only …`。此模式直接运行 DMG 内置启动器并覆盖同一服务与数据流程，报告会明确写入 `nativeAppLaunched: false` 且跳过窗口检查；它不替代本机完整 Cocoa 验收。

截至本次复查，[GitHub 官方 runner 表](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)将 `macos-latest` 列为 arm64，与当前包架构一致。workflow 不依赖个人签名身份或公证凭据；本地隔离构建与 service-only 命令的结果不能冒充一次实际 GitHub Actions 运行记录。

Finder 窗口在映像根目录提供「织识.app」、「Applications」快捷入口和「安装与备份说明.html」。模板指定 640×420 图标视图，应用在左、Applications 在右、说明在下方；采用仅含静态窗口与图标记录的预生成布局模板，不记录个人目录。已有 Finder 窗口或标签页可能继承用户的视图和窗口偏好；本机新开的图标视图已确认三个入口位置正确，没有修改全局 Finder 偏好。常规 GitHub 构建只复制模板，不需要 Finder 自动化或额外 Python 依赖。再生脚本为 `scripts/generate-install-layout.py`，格式沿用 [dmgbuild 官方实现](https://github.com/dmgbuild/dmgbuild/blob/main/src/dmgbuild/core.py)，使用 [ds_store 1.3.3](https://ds-store.readthedocs.io/en/latest/)。按说明将应用拖入 Applications；升级前退出应用并复制整个知识库，保留 `.weave` 与 `.git`。

Dock 图标按用户提供的哔哩哔哩参照缩小可见外轮廓。背景和编织线条整体居中缩放 85%，1024×1024 画布内可见范围为 816×816、每侧透明留白 104 像素；本机哔哩哔哩 ICNS 的同规格可见范围为 818×819、左上留白 103 像素。比较以 alpha ≥ 0.5 的像素边界为准，网页标识不受影响。

## 当时结果

最终 DMG 已通过原生模式 30 项、service-only 模式 29 项安装验收。完整备份 41 个文件逐一哈希一致，卸载应用后原知识库仍保留，重新安装并恢复后检索与历史问答引用可用。最终图标从已安装副本的 ICNS 实际读取，与上文透明边界一致。

原生设置菜单、Cmd+,、文本编辑命令与文件选择面板在实际安装副本复核；保存面板下载的 Markdown 与原件字节一致，修复后下载不再阻塞菜单。图标调整后的最终副本再次确认 Cmd+Q 后应用、启动器与服务监听均停止。前次下载与编辑交互记录明确对应前次包，本次仅修改桌面图标，不改变 `Main.swift` 或启动器。最终窗口截图为 `docs/screenshots/quality-native-wiki-2026-10-03.png`；Finder 安装布局截图在图标调整前拍摄，显示同一布局位置。

产物为 `dist/quality-2026-10-03/Weave-0.2.0-macOS-arm64.dmg`，93,170,057 字节（约 88.85 MiB），SHA-256 为 `b185ee2cc265fb8af0888928a14fddcc3cc67829bedc9ec33195f3f6a0b1a40b`。签名状态为 `preview-ad-hoc`、未公证；没有实际 GitHub Actions 运行记录。构建清单与原生／服务／交互机器报告分别为 `*.build.json`、`*.native-acceptance.json`、`*.service-acceptance.json`、`*.ui-acceptance.json`；默认 `*.acceptance.json` 保留完整原生模式结果。

公开机器证据：[原生模式](evidence/quality-2026-10-03/native-acceptance.json) · [服务模式](evidence/quality-2026-10-03/service-acceptance.json) · [图标与退出](evidence/quality-2026-10-03/ui-acceptance.json)。机器报告移除了临时用户目录和已清理的窗口留存信息，检查结果、包指纹和耗时保留原值。
