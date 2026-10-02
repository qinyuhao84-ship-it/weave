# 第三方与参考来源

织识自己的代码按根目录 MIT License 提供。以下项目与参考来源不因本项目的许可证而改变许可或归属：

- LLM Wiki 思路参考 [Andrej Karpathy 的公开笔记](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)，README 使用概述而非长段复制。
- 界面色彩与设计令牌参考 [AIPRD](https://aiprd.zuoxue.com/zh/home)。`design/` 中记录参考出处及提取的设计数据；AIPRD 的品牌、内容和站点资产不属于本项目。
- Next.js、React、SQLite 驱动、Drizzle、Markdown 渲染组件及其他依赖遵循各自许可证，具体版本由 `pnpm-lock.yaml` 固定，可在安装包中查看许可文件。
- 可选 Docling 与 OCR 模型由使用者另行安装或下载，遵循各自组件及模型的许可。
- 工程测试使用合成样本；真实评测使用 MIRACL/Wikipedia 与 CMRC2018，许可与归属见 [评测资料说明](docs/evaluation/2026-10-02/DATA-NOTICE.md)。不包含作者个人知识库或模型权重。
- macOS 包内聚合独立的 Node.js 26.3.1（MIT 及其组件许可）和 Git 2.56.0（GPLv2）。各组件许可、生产依赖清单与许可文件在应用包 `Contents/Resources/licenses/` 中；Git 对应源码随 Release 附件提供。构建参数见 [桌面应用说明](docs/desktop.md)。聚合不改变各组件许可。

分发依赖或加入第三方资产时，请同时保留相应许可与版权声明；不要将本项目 MIT 许可证视为第三方品牌或资产的授权。
