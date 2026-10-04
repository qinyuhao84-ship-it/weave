# v0.2.3 发布验收

验收日期：2026-10-05。发布源码来自公开仓库 `qinyuhao84-ship-it/weave` 的独立完整克隆。发布文件清单共 526 个文件；清单不含本地知识库、数据库、配置文件、依赖缓存和开发工作树。

## 构建与检查

环境：macOS 15.7.4、Apple Silicon、Node 26.3.1、pnpm 11.7.0、Swift 6.2.4。DMG 内置 Node 26.3.1 与 Git 2.56.0。

| 检查 | 结果 |
| --- | --- |
| `pnpm install --frozen-lockfile` | 通过 |
| `pnpm lint` | 通过，零警告 |
| `pnpm typecheck` | 通过 |
| `pnpm build` | 通过 |
| `pnpm package:mac` | 通过；签名检查与 DMG 校验通过 |
| Gitleaks 8.30.1 | 发布文件与完整 20 个提交历史均通过；零发现 |
| `pnpm test`、`pnpm test:e2e` | 本次未运行 |
| 桌面应用安装后启动验收、真实模型回答验收 | 本次未运行 |

DMG 仅提供 Apple Silicon；构建最低 macOS 13.5。应用使用 ad-hoc 签名，未进行 Apple Developer ID 签名或公证。首次从网络下载后，macOS 可能显示安全提示。

## 对应文件

构建清单中的源码指纹为：

`a4af9a0fdfcdf6351f5eca1f1bc9d0a46b44f7d0f65ec7797bc0d94182ca8536`

| 文件 | 大小 | SHA-256 |
| --- | ---: | --- |
| `Weave-0.2.3-macOS-arm64.dmg` | 94,701,910 字节 | `66b9ae406b9fc823d5470f0ede0ae151bd16aa0a69876728709fdb6607db2156` |
| `Weave-0.2.3-macOS-arm64.build.json` | 见 Release 附件 | `d10f27080861a1ce12289584be6c603a61b2c81a106987c6415227cff1fe9691` |

DMG 使用 `hdiutil verify` 检查通过。签名状态和逐文件包体清单见构建清单，全部 Release 附件的校验和见 `SHA256SUMS.txt`。

本次没有运行单元测试、浏览器测试、桌面安装流程或真实模型质量评测。此记录只说明上表实际完成的检查，不代表这些未运行项目已经通过。
