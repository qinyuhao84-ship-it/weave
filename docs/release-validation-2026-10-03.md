# v0.2.2 发布验收（2026-10-03）

本版沿用公开 Git 历史，在独立克隆中整理运行代码与文档，应用运行代码提交为 `1b30697588eae6bbc0521d46bd655bd9c75bb21b`。未复制作者环境文件、知识库、数据库或位置配置；依赖安装使用固定锁文件，复用本机 pnpm 缓存，运行时下载复用经固定 SHA-256 校验的官方归档。

## 工程与安装

环境：macOS 15.7.4／Apple M2、Node 26.3.1、pnpm 11.7.0；浏览器使用 Chrome 隔离无界面进程。单元与浏览器测试使用临时知识库及本地协议模拟服务。

| 检查 | 本版结果 | 证据 |
| --- | --- | --- |
| 固定锁文件安装、lint、生产构建、typecheck | 通过，PDF 兼容警告已消除 | [检查记录与日志指纹](evidence/release-v0.2.2/checks.json)；原始日志随 Release 验收附件提供 |
| 完整单元测试 | 53 个文件／814 项通过，248.57 秒 | 同上；覆盖回答失败、迁移保留、重复 ID、文件恢复和服务协议 |
| 完整浏览器验收 | 37 项通过，2.9m | 同上；包含实际中文 PDF 生产导入、请求恢复、窄屏、键盘、隔离附件和减少动态效果 |
| DMG 原生模式 | 30 项检查通过，实际启动 Cocoa 应用 | [原生机器记录](evidence/release-v0.2.2/native-acceptance.json) |
| DMG 服务模式 | 29 项通过；窗口检查明确跳过 | [服务机器记录](evidence/release-v0.2.2/service-acceptance.json) |
| 完整备份、卸载保留资料、重新安装与恢复 | 41 个备份文件逐一哈希一致，恢复后检索及会话引用可用 | 原生与服务机器记录；包含 `.weave`、`.git`、Markdown 与原件 |

安装验收只读挂载 DMG，复制到独立临时安装目录，以 `/usr/bin:/bin` 初始 PATH 启动包内程序；检查内置 Node、包体签名、单实例、Markdown 写入与 Git 备份、中文 PDF 离线解析、全文检索、模拟问答及引用、重启和全部子进程退出。机器记录仅移除临时用户目录，结果与指纹保留原值。

本版原生菜单与下载交互沿用同一修复实现；发布前实际窗口记录见[桌面复验](desktop-quality-2026-10-03.md)。本版自动验收没有重新执行所有系统面板的人工交互。

同一运行代码提交的 GitHub 检查全部通过：[macOS／Ubuntu 工程与完整历史凭据检查](https://github.com/qinyuhao84-ship-it/weave/actions/runs/37102619854)，[独立 macOS 桌面构建与服务模式验收](https://github.com/qinyuhao84-ship-it/weave/actions/runs/37102621124)。云端桌面产物另行构建；本页 DMG 指纹对应本地原生验收附件。

## 源码与附件对应

- 安装包：`Weave-0.2.2-macOS-arm64.dmg`，94,542,033 字节。
- DMG SHA-256：`40f0fa7278803070030f9d05a9ce2bb9003193d9d08e49833a4f4cb6e0cba438`。
- 运行源码 SHA-256：`e54cdcca06bf09e170ded6cfa8ddc9a6b6af39ce55f5dd1c6df28806c9dfe248`，算法见 [sourceFingerprint](../scripts/desktop-package-utils.mjs)，包含运行代码、桌面资源、脚本、迁移与固定配置。
- 签名：`preview-ad-hoc`，未公证；内置 Node 26.3.1、Git 2.56.0，构建清单记录 388 个生产依赖条目。

[Release](https://github.com/qinyuhao84-ship-it/weave/releases/tag/v0.2.2)提供本标签源码、DMG、构建清单、验收日志归档、Git 对应源码与全部附件校验和。源码压缩包对应标签的完整 Git 文件；运行源码指纹与包内清单对应，文档修订不改变该运行指纹。

六项附件均通过无需 GitHub 登录的公开地址重新下载，文件大小、SHA-256 与上传前本地记录逐项一致，`SHA256SUMS.txt` 和下载后 DMG 完整性检查通过。v0.2.0 的四项历史附件名称、大小与摘要保持原样。[公开下载机器记录](evidence/release-v0.2.2/public-download-verification.json)。本版源码标签为 `f0cf63d9909bc5902111e56417a8367407e0a767`；后续文档记录不改写标签或附件。

## 公开范围与凭据检查

公开范围由 [release-files.txt](release-files.txt)逐项列出；真实环境、知识库、数据库、依赖、构建、测试产物和内部审计不进入 Git 提交。`.impeccable/` 为本机内部审查目录，已加入忽略规则；`.env.example` 仅含注释示例。

Gitleaks 固定为 8.30.1，官方 darwin-arm64 归档 SHA-256 为 `b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5`；使用 `--redact=100` 扫描发布文件和 `--log-opts=--all` 完整可达历史。扫描报告随验收附件提供。

包内扫描报告 3 项 Next.js 构建数据：`previewModeSigningKey`、`previewModeEncryptionKey` 与 `encryptionKey`，分别位于两个生成清单。安装版本的 Next 构建源码说明这些值按构建自动生成；Server Actions 清单为空，本项目没有使用预览数据接口。保留原始脱敏扫描发现，未添加长期扫描例外，也未忽略整个测试或构建目录。本机已知服务凭据精确匹配另行检查发布文件、包内文件和完整公开历史，未发现命中。

## 历史指标与支持范围

v0.2.0 的真实检索和问答指标、三轮报告、失败样例、数据哈希与附件继续保留。v0.2.2 没有重新运行真实模型质量评测；单测、浏览器与安装协议模拟不能增加真实问答样本。[冻结指标](evaluation/2026-10-02/metrics.md)。

桌面包仅提供 Apple Silicon，构建最低 macOS 13.5，当前实测 15.7.4。未进行 Developer ID 签名或 Apple 公证，互联网下载后的 Gatekeeper 提示仍由系统决定。单用户、本机运行；云端服务会收到所需内容，本地密钥存储未加密，OCR／PPTX 需单独配置解析服务。可访问性检查未覆盖全产品人工读屏，恢复无法保证所有硬件故障；[产品取舍](project-introduction.md)集中说明使用影响。

## 依赖安全

实际 PDF 文本提取通过 unpdf 官方 `definePDFJSModule` 接口使用 `pdfjs-dist` 6.2.108，替换内置旧引擎；Next 保留 Node 原生加载，引擎与 worker 显式随包分发。[引擎版本与真实正文测试](../tests/parse.test.ts)。[PDF.js 官方漏洞公告](https://github.com/advisories/GHSA-hq66-cqwq-w95j)的修复版本为 6.2.108。

`pnpm audit --prod --json` 检查生产依赖，已知漏洞为零；[原始报告](evidence/release-v0.2.2/dependency-audit-production.json)。完整依赖检查仍有一项高危开发依赖公告：[braces 栈耗尽问题](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm)，当前没有已发布补丁。`braces` 3.0.3 经 `eslint-config-next → @next/eslint-plugin-next → fast-glob → micromatch` 引入，不属于生产依赖树；仅对可信源码运行开发检查。[完整报告](evidence/release-v0.2.2/dependency-audit-all.json)。

这些结果对应本次查询与锁文件；未将历史版本的零漏洞结果写成当前完整依赖检查结果。v0.2.1 的预发布验收保留于[历史记录](release-validation-v0.2.1.md)。
