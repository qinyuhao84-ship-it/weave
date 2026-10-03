# 中文真实检索评测

本工具测量公开人工标注数据上的检索质量，并保留逐题结果、片段与耗时。工程门槛不代表知识库产品的行业平均。模拟端点只用于协议回归；真实质量报告使用硅基流动 BGE-M3 / BGE 重排。

## 数据与隔离

首轮数据清单见 [manifest](evaluation/2026-10-02/dataset-v2/manifest.json)。随机种子为 `20261002`，包含 10,000 段 MIRACL 中文资料、80 篇 CMRC2018 资料，200 个开发问题、200 个留出问题，以及 80 个有答案和 20 个受控缺证据场景。源版本、来源许可证、文件 SHA-256 和划分保存在清单中。重新准备后的三个文件哈希必须与清单相符。

MIRACL 官方 train 用作开发池，官方 dev 用作留出池。去除规范化后重复的问题，并隔离两组正例的维基文章 ID。使用官方 Parquet 转换中的 15,243 个已判定段落构造语料：保留所选问题全部正例与已标注负例，再固定抽取干扰资料。这是受限语料实验，不能与 MIRACL 全量中文维基排行榜直接比较。每个 MIRACL 段落独立成为临时词条，同文章的多个段落可能拥有同一标题；并非实际用户知识库的完整文章分布。资料没有图谱边，因此本轮不能验证图谱扩展收益。

CMRC 选择不同标题的文章，保留可验证的答案原文位置。缺证据场景移除整篇文章，检查全语料不含任何标准答案，并记录标题/主题核查；其结果单独报告，不视为自然无答案标注。资料版权及核查见 [来源说明](evaluation/2026-10-02/DATA-NOTICE.md)。

数据正文和真实向量缓存位于忽略的 `.eval-cache/`。评测通过已有 Markdown 索引器在独立临时目录建库，调用现有检索及问答入口。个人 SQLite 仅以只读连接获取检索配置；不会读取个人正文、会话或裁决。临时数据库内才保存评测配置与会话；结束后清理该临时目录。评测 BM25 使用独立、经 ICU 中文词语切分的 FTS5 索引，生产索引保持原样。

## 复现检索实验

最终通过的第三轮数据见 [清单](evaluation/2026-10-02/round-3/dataset/manifest.json)，使用种子 `20261004`，需要保留历史排除清单。以下命令适用于全新复现目录；已有评测数据及测试锁保持原样：

```bash
pnpm eval prepare --data .eval-cache/reproduction/v2 --seed 20261002
pnpm eval prepare --data .eval-cache/reproduction/v3 --previous .eval-cache/reproduction/v2 --seed 20261003
pnpm eval prepare --data .eval-cache/reproduction/v4 --previous .eval-cache/reproduction/v3 --seed 20261004
```

后续命令均追加 `--data .eval-cache/reproduction/v4` 即使用最终语料，先核对三个正文/划分文件哈希与第三轮清单。严格复现应使用冻结回执对应的代码与依赖版本。已有公开留出只允许复现同一冻结方案，不得将复现结果再次用于调参。

先安装锁定依赖，配置免费的检索 API Key；可以沿用本机已保存的硅基流动检索凭据，也可以仅设置 `WEAVE_EVAL_RETRIEVAL_API_KEY`。不自动选择 `Pro/` 或其他付费模型。第一次运行约准备 10,083 个真实向量段，随后按请求参数与正文哈希复用缓存。

```bash
pnpm install --frozen-lockfile
pnpm eval prepare
pnpm eval measure --out .eval-cache/dev-new \
  --original docs/evaluation/2026-10-02/original-retrieve.ts.txt
pnpm eval experiment --dev .eval-cache/dev-new --out .eval-cache/rank-exploration.json
pnpm eval compare --dev .eval-cache/dev-new --baseline vector --out .eval-cache/dev-comparison
pnpm eval freeze --dev .eval-cache/dev-new --out .eval-cache/frozen.json
pnpm eval measure --split test --methods original,current,vector \
  --freeze .eval-cache/frozen.json --out .eval-cache/test-new
pnpm eval compare --dev .eval-cache/test-new --baseline vector --out .eval-cache/test-comparison
pnpm eval measure --split test --suite evidence --methods original,current,vector \
  --freeze .eval-cache/frozen.json --out .eval-cache/evidence-new
```

`compare --dev` 表示待比较结果目录，既可传开发结果也可传留出结果。冻结时自动在 BM25、纯向量和标准 RRF+重排中选择开发 nDCG 最高者；留出命令的 `--methods` 必须包含该基线、原实现和当前实现。各方法统一 BGE 模型、Top-K=10、单词条上限 3,000 字符。检索套件上下文预算为 24,000 字符；证据套件使用问答的同一问题指令与 32,768 token 窗口对应的 8,192 字符预算。

已存在的冻结数据、已完成的结果和冻结回执不能覆盖。`--data`、`--cache`、`--out` 可分别指定独立目录。原实现快照必需，避免错误地把优化后的代码当作优化前代码。`--offline` 只允许已有真实缓存，不补调用；缓存遗漏计为失败或降级，不得用这类运行冻结方案。

留出评测核验数据、检索代码、相关依赖及评测程序哈希，并写一次性测试锁。测试结果公开后，不得再次使用该集调参。若需要继续优化，应建立排除已使用问题及答案文章的新留出集；仅换随机种子不足以证明新集合独立。`pnpm eval prepare --data .eval-cache/dataset-next --previous .eval-cache/dataset-v2 --seed 20261003` 会保留开发问题，排除历史问题、正例文章和问答标题；后续继续换新的目标目录并传入上一轮目录，累计排除历史留出集。新的留出池可以混合剩余官方 train/dev 问题，来源记录在 ID 和清单中，不能横向直接比较不同轮次的总分。中断保留逐题文件与缓存；测试锁保留，不能删除锁来反复试验。

每轮只调整一类因素。首轮候选从 30 扩大到 50 后 nDCG 下降且有降级，已撤回。开发轨迹比较 RRF 权重、常数、置信差阈值与分数融合后，首轮尝试 BGE 重排分数加 `8 × 余弦相似度` 的排序校准，但其留出提升仅 2.01 个百分点且低于原实现，已撤回。第二轮先验证低置信差的 RRF，再基于开发失败样例比较分数校准，最终冻结 `logit(重排分数) + 40 × 余弦相似度`，置信差阈值为 0.3；只对精确的 `BAAI/bge-m3` / `BAAI/bge-reranker-v2-m3` 组合启用，其他模型、分数不在 [0,1] 或置信差达到阈值时继续使用原重排顺序。这些参数来自开发集探索，仅适用于本次开发集。第二轮留出未达标，该校准方案已撤回。第三轮仅对同一 BGE 组合去掉重排请求中的重复标题，再依据开发结果冻结 `logit(重排分数) + 30 × 余弦相似度`、置信差阈值 0.2；其他型号保留原输入和顺序。第三轮结论见其独立留出报告。无需增加网络调用或索引规模。相关记录见 [第三轮开发结果](evaluation/2026-10-02/round-3/dev-final/summary.json) 与 [排序探索](evaluation/2026-10-02/round-3/rank-exploration.json.md)。BGE 官方说明归一化分数使用 sigmoid；这里逆变换只用于本模型组合的开发集校准，不将分数视为正确概率。

## 指标与耗时

- Recall@K：前 K 个不同结果中的已标注相关段落数 / 全部已标注相关段落数；Hit@K 为是否至少命中一个。
- `MRR@10`：第一个相关结果排名的倒数；`nDCG@10` 使用 `2^relevance−1` 增益和 `log2(rank+1)` 折扣，再按理想排序归一化。
- `Precision@5`/10 的分母固定为 5/10，不足 K 个结果也不缩小分母。未标注结果计 0，但不能据此断言其不相关。另报前 10 个实际返回结果中的已标注准确率和标注覆盖率；没有已标注结果时前者为 `null`。
- CMRC 证据召回要求标准答案确实出现在最终返回的原文片段中。仅命中词条而答案已被截断不算证据命中。MIRACL 没有答案跨度，证据指标为 `null`。
- 失败样本保留，质量按 0 计入；服务降级单独计数。配对 bootstrap 固定种子、5,000 次重采样，报告 nDCG 差值的 95% 区间。

各方法保存 `rows.jsonl`（指标、片段、耗时和请求/缓存数量）、`trace.jsonl`（候选、原始重排分数、最终片段与阶段时间）、`summary.json`（宏平均、环境、失败率、降级率、中位数与经验 P95）。`compare` 额外输出中文 `report.md`、`comparison.json`、`failures.json`。

本地计算为查询总耗时减真实嵌入/重排网络阶段；网络计时含完整响应下载、同题重试等待。缓存重放只用于质量和本地计算对比。网络延迟仅统计实际发生调用的问题，零次调用时样本数为 0、中位数/P95 为 `null`；不能将缓存运行总耗时视为线上等待。建库和批量嵌入准备不进入查询延迟。运行时不要并行构建、测试或其他重负载作业；同环境同语料按题交错运行方法。

检索验收条件为 `Recall@10`≥85%、`nDCG@10`≥0.70、相对预选基线提升≥3 个百分点、配对 95% 区间下界>0、召回下降≤2 个百分点、本地 P95≤原实现的 1.2 倍。未全部通过就报告差距，不写成“超过市场平均”。

## Go 问答复核及预算

不修改日常模型配置。凭据仅通过本机环境变量读取，请不要在聊天或报告中粘贴。执行前，须从账号控制台确认当前剩余用量、窗口截止时间和余额备用方式关闭状态：

```bash
export WEAVE_EVAL_GO_API_KEY='本机评测专用凭据'
export WEAVE_EVAL_GO_REMAINING_USD='控制台当前剩余美元用量'
export WEAVE_EVAL_GO_QUOTA_CHECKED_AT='最近核查的 ISO 时间'
export WEAVE_EVAL_GO_WINDOW_END='当前窗口截止的 ISO 时间'
export WEAVE_EVAL_GO_BALANCE_FALLBACK='off'
pnpm eval answers --out .eval-cache/answers
pnpm eval review --out .eval-cache/answers --reviews .eval-cache/reviews.jsonl
```

核查时间必须在执行前 10 分钟内，窗口必须尚未结束且不超过 5 小时。官方 `GET https://opencode.ai/zen/go/v1/usage` 可读取各窗口的实际用量百分比和结束时间；按对应型号额度保守取滚动、周、月窗口剩余金额的最小值。余额备用方式状态仍须核验已登录控制台的 Extra usage 开关。模型列表可访问不能代替额度确认。任何条件缺失，命令写 `answer-status.json`，不发送问答请求。额度小于 $4.8 时降低本轮上限，禁止余额备用方式或付费直连回退。

2026-10-02 冻结评测依据当时官方 [Go 额度规则](https://opencode.ai/docs/go/#usage-limits)：普通 Go 的 `deepseek-v4-flash` 月额度 $30，5 小时窗口为其 20%（$6）；不能套用其他型号或 Plus 额度。当时按高峰输入 $0.30/M、输出 $1.20/M 保守计价；重新执行前需核对官方价格与账号额度。任务累计上限 $4.8、尝试次数上限 400、单次最大输出 2,048 token，预算优先于次数。发送前按 UTF-8 字节和消息开销预留输入上界及最大输出成本，实际 usage 返回后结算；缺 usage、失败或不完整流保留预留金额。超限、取消或窗口结束立即停止，保存进度，不自动重试或跨窗口续跑。

账本与并发锁保存在缓存目录的 `go-budget.json` / `go-budget.lock`，不可更换目录或删除账本来绕过累计上限。正常退出清理锁，异常退出需先确认没有在途请求，保留账本。问答输出保存完整返回内容、引用、真正召回的片段、token usage、首字/完成时间及待复核字段。本次问答逐题依据标准答案、实际原文与额外断言复核，并保存对应记录。自动答案匹配只是辅助信号，不算正式正确率。

复核 JSONL 每行至少包含：

```json
{"id":"公开场景 ID","correct":true,"citationsSupported":true,"notes":"答案与原文的对应位置；核验额外结论及引用支持关系","reviewer":"复核者","method":"human"}
```

必须覆盖全部 100 个场景（包括失败），ID 不重复。`method` 可为 `human` 或 `agent-assisted`，需如实标明。正确性同时检查标准答案、原文证据及额外断言，引用支持不能用编号合法代替。有答案与受控无答案分开统计；达到正确率≥85%、引用支持≥95%、拒答≥90% 后才通过问答验收。没有完整复核记录就保持待验收。

## 离线回归

普通 CI 的 `pnpm test` 已包含指标、去重/缺失标注、证据截断、缓存失效及无效响应、取消、服务降级、预算预留/停止/跨窗口保护和冻结校验。它们使用临时资料与模拟协议，不调用真实端点，不证明真实模型质量。

```bash
pnpm lint
pnpm build
pnpm typecheck
pnpm test
pnpm test:e2e tests/e2e/retrieval.spec.ts tests/e2e/model-recovery.spec.ts
```

构建与类型检查顺序执行。完整交付状态、留出结果与未通过项见 [首轮执行记录](evaluation/2026-10-02/README.md)。

完整冻结数据、源码与逐题追踪见 [v0.2.0 评测附件](https://github.com/qinyuhao84-ship-it/weave/releases/download/v0.2.0/Weave-evaluation-2026-10-02.tar.gz)，原始正文依来源许可分发；Git 仅保留较小的报告和标注。
