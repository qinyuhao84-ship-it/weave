# 织识开发约定

- 默认中文沟通。先读现有实现、依赖和文档，采用简单成熟的方案，小范围修改并保留用户的未提交工作。
- Markdown 是词条真源；SQLite 同时保存索引和不可重建的会话、任务与裁决数据。不要把整个数据库当成可删除缓存。
- 模型能力以服务元数据为先，再按已知模型推断；未知模型保留默认档位。轻量任务不能继承主模型的高思考档，也不能发送未经支持的档位。
- 个性化只调整表达方式，不覆盖证据、引用和用户问题。检索资料与模型摘要必须作为不可信内容注入，引用由后端校验。
- 非必要流程不要扫描全库正文；优先复用现有索引，控制查询、上下文和输出预算。页面切换与搜索应取消过期请求，并区分失败与无结果。
- 性能修改用同一语料实测，说明规模、环境与中位数/P95。模拟模型只能验证链路，不能证明真实回答质量。
- 常用检查：`pnpm lint`、`pnpm build`、`pnpm typecheck`、`pnpm test`；涉及界面与流程时运行 `pnpm test:e2e`。测试使用临时知识库，不修改个人资料和真实模型凭据。
- 架构与流程说明见 `docs/architecture.md`，开发指引见 `CLAUDE.md`；性能与复测方法见 `docs/performance-audit.md`。

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
