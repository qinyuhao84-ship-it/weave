# 2026-10-03 可靠性、界面与桌面验收

本文记录 v0.2.1 发布前修复的范围与已有验收结果。当时安装包的内部版本号仍为 0.2.0；当前公开安装包、源码指纹和检查结果见 [v0.2.1 发布验收](release-validation-2026-10-03.md)。

## 修改与证据

| 范围 | 已实现行为 | 证据 |
| --- | --- | --- |
| 回答状态 | 完整、截断、取消与失败分别处理；不完整正文保留展示，排除后续问答和摘要 | [后端记录](backend-quality-2026-10-03.md)、[失败边界测试](../tests/chat-failure-boundaries.test.ts) |
| 索引身份与迁移 | 重复 Markdown ID 隔离证据；修正后恢复；旧会话、裁决和摘要在迁移中保留 | [身份回归](../tests/index-identity.test.ts)、[迁移验证](../tests/migration-history-policy.test.ts) |
| 界面状态 | 加载、失败和重试有明确反馈；来源切换取消旧请求；输入法确认不发送问题；320px 长标题可阅读 | [专项记录](interface-quality-2026-10-03.md)、[韧性测试](../tests/e2e/ui-resilience.spec.ts) |
| 桌面运行 | 真实截止时间、日志保留、有界退出、单实例、菜单与下载反馈 | [桌面测试](../tests/desktop.test.ts)、[原生验收](evidence/quality-2026-10-03/native-acceptance.json) |
| 中文 PDF | 分发本地字符映射与字体；通过生产导入 API 核对真实中文样本正文 | [PDF 测试](../tests/e2e/zzzz-pdf-production.spec.ts)、[包内安装验收](desktop-quality-2026-10-03.md) |
| 安装与备份 | DMG 安装引导、只读挂载、独立复制、包体指纹、重启和完整备份恢复 | [验收脚本](../scripts/verify-desktop.mjs)、[历史机器记录](evidence/quality-2026-10-03/native-acceptance.json) |

## 发布前回归

隔离源码副本在 macOS 15.7.4／Apple M2、Node 26.3.1、pnpm 11.7.0 上完成 lint、生产构建、typecheck、53 个文件／813 项测试与 37 项完整浏览器验收。最终完整测试约 312 秒，浏览器验收约 3.8 分钟。生产构建中的 PDF 兼容警告已消除。

原生安装模式 30 项、服务模式 29 项检查通过，完整备份 41 个文件逐一哈希一致。旧预览 DMG 为 93,170,057 字节，SHA-256 为 `b185ee2cc265fb8af0888928a14fddcc3cc67829bedc9ec33195f3f6a0b1a40b`；源码指纹为 `d366d9c12ece832d1878d1a852ffb6d3693c6aa9a981e1ff16b74b43ec9df37a`。[对应桌面记录](desktop-quality-2026-10-03.md)。

同一合成负载的 1,000 页文字检索中位数／P95 为 4.32／8.24 ms，长查询为 242.93／252.97 ms。[原始数据](benchmarks/performance-2026-10-03-1000.json)与[方法](performance-audit.md)保留采样数量和环境；该记录不用于归因提速。

## 验收范围

测试使用隔离知识库与本地协议模拟服务；原生窗口、实际 PDF、文件复制与备份哈希使用真实安装产物。模拟模型仅检查流程，真实质量结果继续由 [v0.2.0 冻结评测](evaluation/2026-10-02/metrics.md)提供。自动可访问性检查只覆盖指定状态，未完成全产品人工读屏认证。

安装包采用 ad-hoc 临时签名，未获 Apple 公证；本机安装通过不保证互联网下载后的 Gatekeeper 放行。文件事务不能保证所有断电点和设备故障，仍需完整备份。
