# 性能基准与复测方法

以下为 2026-10-01 在独立克隆中重新测得的首版结果。环境：macOS 15.7.4 / arm64、Node 26.3.1、pnpm 11.7.0、Next.js 16.3.6；使用临时 SQLite 与合成 Markdown，不读取个人资料、不调用模型。没有同时运行单元或浏览器测试。

每篇共享正文 11,500 字符，导入文档 172,548 字符。各项先预热，再测 12 次；长文上下文测 5 次。中位数使用中央位置，偶数样本取中央两值均值。P95 使用经验分位数；12 次和 5 次采样下均等于最大值，样本量小，不代表线上 SLA。硬件和运行负载未标准化，跨机器对比需重新测量。

| 测项 | 300 词条中位数 / P95 | 1,000 词条中位数 / P95 |
| --- | --- | --- |
| 完整目录（含全部摘要） | 12.04 / 12.78 ms | 41.40 / 42.57 ms |
| 分页目录（50 条摘要） | 2.79 / 2.89 ms | 4.21 / 5.63 ms |
| 双链解析表 | 0.94 / 1.10 ms | 2.81 / 3.80 ms |
| 普通问题检索 | 4.00 / 4.28 ms | 5.16 / 5.64 ms |
| 长问题检索 | 73.48 / 74.23 ms | 240.52 / 256.85 ms |
| 正文片段定位 | 0.16 / 0.25 ms | 0.17 / 0.21 ms |
| 长文相关词条上下文 | 26.30 / 27.32 ms | 73.83 / 76.88 ms |

完整原始结果见 [300 词条 JSON](benchmarks/performance-300.json) 与 [1,000 词条 JSON](benchmarks/performance-1000.json)。这些结果只描述当前实现，不与公开仓库未包含的旧实现作提速对比。

## 2026-10-02 混合检索复测

沿用上面的合成语料、环境与统计定义，在单元与浏览器测试结束后运行。每词条正文仍为 11,500 字符，使用 2,000 字符重叠分段和 1024 维归一化模拟向量。模拟端点仅返回确定性向量，不发送个人资料或使用真实凭据；重排在此性能测项中关闭。向量测项包含本地精确扫描、候选融合、图谱扩展与正文读取，也包含模拟查询向量的协议开销。

| 测项 | 300 词条中位数 / P95 | 1,000 词条中位数 / P95 |
| --- | --- | --- |
| 当前普通文字检索 | 3.63 / 3.91 ms | 3.88 / 4.49 ms |
| 当前长问题文字检索 | 74.43 / 75.84 ms | 245.67 / 265.03 ms |
| 当前本地混合检索（无真实网络／重排） | 26.91 / 57.84 ms | 43.95 / 92.50 ms |

原始结果：[300 词条](benchmarks/hybrid-300.json)、[1,000 词条](benchmarks/hybrid-1000.json)。真实嵌入和重排的网络等待另计；该表不能作为完整问答延迟、检索质量或线上 SLA。硬件负载未标准化，P95 的少量样本仍会受调度影响。精确向量扫描成本随分段数量与维度增长，当前没有引入近似向量索引。

```bash
WEAVE_PERF_PAGES=300 WEAVE_PERF_HYBRID=1 pnpm exec tsx scripts/performance-benchmark.mts /tmp/weave-hybrid-300.json
WEAVE_PERF_PAGES=1000 WEAVE_PERF_HYBRID=1 pnpm exec tsx scripts/performance-benchmark.mts /tmp/weave-hybrid-1000.json
```

## 复现

```bash
pnpm exec tsx scripts/performance-benchmark.mts /tmp/weave-performance.json
WEAVE_PERF_PAGES=1000 pnpm exec tsx scripts/performance-benchmark.mts /tmp/weave-performance-1000.json
```

脚本在临时目录生成合成 Markdown 和 SQLite，自动清理。JSON 记录时间、运行环境、规模、样本数、中位数与 P95，可在自己的机器复测。分页目录和完整目录返回内容不同，不能当作等功能的直接测速对比。短词兜底、大库与极端长问题仍有成本。

模型等待与本地计算应分别测量。真实模型质量需要人工标注和语义核对；引用编号合法不等于所有结论被证据支持。已建立固定版本的 MIRACL 中文检索集及 CMRC2018 问答复核集，见 [真实评测与复现](retrieval-evaluation.md) 和 [完整执行记录](evaluation/2026-10-02/README.md)。该受限语料评测不代表行业平均，也不根据少量抽查自动降低用户选择的思考强度。

显式运行合成回答抽查会读取本机模型配置并消耗额度，仅发送脚本内的合成资料。报告默认写到 `/tmp`，不应提交实际端点配置或原始日志。本轮未执行该命令。

```bash
pnpm exec tsx scripts/answer-quality-benchmark.mts /tmp/weave-answer-quality.json
```

性能修改先运行相关性、预算、取消与故障恢复测试，再比较同一语料、环境和定义的测量。构建与类型检查顺序执行；浏览器服务运行期间不要重建生产目录。全部验收结果见 [validation.md](validation.md)。
