# 评测资料来源与版权

本次评测由 MIRACL 中文人工相关性标注与 CMRC2018 中文机器阅读理解资料派生。项目程序的 MIT 许可证不替代上游资料许可证。

- MIRACL：来自 [project-miracl/miracl](https://github.com/project-miracl/miracl) 与官方 [MIRACL 数据卡](https://huggingface.co/datasets/miracl/miracl)。查询、标注与数据元信息按 Apache-2.0 发布，维基正文仍遵守其原始许可。参考 Zhang 等的 *MIRACL: A Multilingual Retrieval Dataset Covering 18 Diverse Languages*。
- 维基语料：来自官方 [miracl-corpus](https://huggingface.co/datasets/miracl/miracl-corpus)，保留文档 ID、标题、原文与来源信息。维基文本的 CC-BY-SA / GFDL 条款继续适用；不能把正文标为本项目原创内容。
- CMRC2018：来自 [官方仓库固定版本](https://github.com/ymcui/cmrc2018/tree/c0eb1b6ba219847457e6af3180da722bbeb656af)，官方 [HFL 数据卡](https://huggingface.co/datasets/hfl/cmrc2018) 标明 CC-BY-SA-4.0。参考 Cui 等，*A Span-Extraction Dataset for Chinese Machine Reading Comprehension*，EMNLP-IJCNLP 2019，[论文](https://aclanthology.org/D19-1600/)。

派生改动包括：固定种子抽样、问题规范化去重、正例文章隔离、额外干扰段落选择、临时词条格式、原文答案坐标，以及删除答案文章的受控无证据场景。模型输出、评测分数和上下文截取由本工具产生；原文未改写。

源版本与下载文件哈希见各版 manifest。v1 的缺证据场景仅检查整篇文章和标准答案缺失，在核查中发现别名仍被其他段落提及；未执行 v1 问答验收。v2 增加规范化主题前三字符的保守排除；保留同一 10,080 篇语料、同一 400 道检索题和 80 道有答案题，仅替换不够严格的受控缺证据题。v1 文件和开发报告保留，v2 独立存放于 `dataset-v2/`。

v2 的 20 个受控场景核查记录见 [controlled-audit.json](dataset-v2/controlled-audit.json)。核查由 Codex 辅助完成，包含主题与答案的全评测语料检查；不宣称自然场景的所有同义表达均经过人工标注。该核查不消耗问答模型额度，也没有读取个人资料。

正文与向量默认只保存在本机 `.eval-cache/`；仓库交付来源清单、划分和复现程序。逐题评测输出中的原文片段仍继承上述上游许可。再分发这些片段时应随附本来源说明和上游许可链接：

- [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0)
- [CC-BY-SA-4.0](https://creativecommons.org/licenses/by-sa/4.0/)
- [GNU FDL](https://www.gnu.org/licenses/fdl-1.3.html)
