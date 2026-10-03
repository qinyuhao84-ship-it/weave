# v0.2.1 预发布验收（2026-10-03 历史记录）

本版沿用公开 Git 历史，在独立克隆中整理运行代码与文档，应用运行代码提交为 `afeb3900fce2a49a412062f839c94d64e01aaa4d`。未复制作者环境文件、知识库、数据库或位置配置；依赖安装使用固定锁文件，复用本机 pnpm 缓存，运行时下载复用经固定 SHA-256 校验的官方归档。

## 工程与安装

环境：macOS 15.7.4／Apple M2、Node 26.3.1、pnpm 11.7.0；浏览器使用 Chrome 隔离无界面进程。单元与浏览器测试使用临时知识库及本地协议模拟服务。

| 检查 | 本版结果 | 证据 |
| --- | --- | --- |
| 固定锁文件安装、lint、生产构建、typecheck | 通过，PDF 兼容警告已消除 | [检查记录与日志指纹](evidence/release-2026-10-03/checks.json)；原始日志随 Release 验收附件提供 |
| 完整单元测试 | 53 个文件／813 项通过，199.40 秒 | 同上；覆盖回答失败、迁移保留、重复 ID、文件恢复和服务协议 |
| 完整浏览器验收 | 37 项通过，约 2.9 分钟 | 同上；包含实际中文 PDF 生产导入、请求恢复、窄屏、键盘、隔离附件和减少动态效果 |
| DMG 原生模式 | 30 项检查通过，实际启动 Cocoa 应用 | [原生机器记录](evidence/release-2026-10-03/native-acceptance.json) |
| DMG 服务模式 | 29 项通过；窗口检查明确跳过 | [服务机器记录](evidence/release-2026-10-03/service-acceptance.json) |
| 完整备份、卸载保留资料、重新安装与恢复 | 41 个备份文件逐一哈希一致，恢复后检索及会话引用可用 | 原生与服务机器记录；包含 `.weave`、`.git`、Markdown 与原件 |

安装验收只读挂载 DMG，复制到独立临时安装目录，以 `/usr/bin:/bin` 初始 PATH 启动包内程序；检查内置 Node、包体签名、单实例、Markdown 写入与 Git 备份、中文 PDF 离线解析、全文检索、模拟问答及引用、重启和全部子进程退出。机器记录仅移除临时用户目录，结果与指纹保留原值。

本版原生菜单与下载交互沿用同一修复实现；发布前实际窗口记录见[桌面复验](desktop-quality-2026-10-03.md)。本版自动验收没有重新执行所有系统面板的人工交互。

[GitHub macOS／Ubuntu 完整回归与历史扫描](https://github.com/qinyuhao84-ship-it/weave/actions/runs/37101264612)全部通过；[干净 GitHub runner 桌面构建](https://github.com/qinyuhao84-ship-it/weave/actions/runs/37101366870)完成固定锁文件安装、生产构建、Git／Swift 编译、DMG 打包与服务模式独立安装验收。两次检查对应运行代码提交 `afeb390`，后续提交只整理公开文档与证据。云端构建产物与本机发布包各有自己的构建指纹；Release 发布本文所验收的本机包。

## 源码与附件对应

- 安装包：`Weave-0.2.1-macOS-arm64.dmg`，93,039,437 字节。
- DMG SHA-256：`4c3da2d197e9884416c59c42a53435faf4bb42cea5cc65945bbf5be7a3e96e14`。
- 运行源码 SHA-256：`dd61d7af9c649c4141cfef726796cbc340c5c26d095e2aa2aa35fd089a637565`，算法见 [sourceFingerprint](../scripts/desktop-package-utils.mjs)，包含运行代码、桌面资源、脚本、迁移与固定配置。
- 签名：`preview-ad-hoc`，未公证；内置 Node 26.3.1、Git 2.56.0，构建清单记录 388 个生产依赖条目。

该预发布版本未公开 Release；保留 `v0.2.1` 源码标签与本页机器证据，本页安装包指纹属于当时的本地验收产物。当前公开附件见 [README](../README.md)。

## 公开范围与凭据检查

公开范围由 [release-files.txt](release-files.txt)逐项列出；真实环境、知识库、数据库、依赖、构建、测试产物和内部审计不进入 Git 提交。`.impeccable/` 为本机内部审查目录，已加入忽略规则；`.env.example` 仅含注释示例。

Gitleaks 固定为 8.30.1，官方 darwin-arm64 归档 SHA-256 为 `b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5`；使用 `--redact=100` 扫描发布文件和 `--log-opts=--all` 完整可达历史。扫描报告随验收附件提供。

包内扫描报告 3 项 Next.js 构建数据：`previewModeSigningKey`、`previewModeEncryptionKey` 与 `encryptionKey`，分别位于两个生成清单。安装版本的 Next 构建源码说明这些值按构建自动生成；Server Actions 清单为空，本项目没有使用预览数据接口。保留原始脱敏扫描发现，未添加长期扫描例外，也未忽略整个测试或构建目录。本机已知服务凭据精确匹配另行检查发布文件、包内文件和完整公开历史，未发现命中。

## 历史指标与支持范围

v0.2.0 的真实检索和问答指标、三轮报告、失败样例、数据哈希与附件继续保留。v0.2.1 没有重新运行真实模型质量评测；单测、浏览器与安装协议模拟不能增加真实问答样本。[冻结指标](evaluation/2026-10-02/metrics.md)。

桌面包仅提供 Apple Silicon，构建最低 macOS 13.5，当前实测 15.7.4。未进行 Developer ID 签名或 Apple 公证，互联网下载后的 Gatekeeper 提示仍由系统决定。单用户、本机运行；云端服务会收到所需内容，本地密钥存储未加密，OCR／PPTX 需单独配置解析服务。可访问性检查未覆盖全产品人工读屏，恢复无法保证所有硬件故障；[产品取舍](project-introduction.md)集中说明使用影响。

依赖检查随后确认 `pdfjs-dist` 6.1.200 在 [GHSA-hq66-cqwq-w95j](https://github.com/advisories/GHSA-hq66-cqwq-w95j) 受影响范围内。当前修复版本见 [v0.2.2 验收](release-validation-2026-10-03.md)；本页记录不代表最新依赖安全状态。
