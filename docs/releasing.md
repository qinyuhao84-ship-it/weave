# 发布检查

织识交付代码供使用者在本机运行；公开 GitHub 代码不需要部署网站或提供共享模型凭据。

## 文件范围

- 提交应用、领域模块、运行脚本、配置示例、锁文件、全部数据库迁移、测试和合成夹具，以及许可证、CI 和公开文档。
- `.env.example` 仅含注释示例。真实环境文件、知识库、位置记录、数据库、缓存、开发工作树、构建和测试产物、内部审计均排除。
- 发布文件清单见 [release-files.txt](release-files.txt)。清单描述该首版快照，后续增删文件需要同步更新。
- `private: true` 防止误发 npm，不影响 GitHub 开源。源码中的模型地址模板属于产品能力；作者实际服务配置不属于交付内容。

## 验收门槛

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm build
pnpm typecheck
pnpm test
pnpm exec playwright install chromium
pnpm test:e2e
```

在独立克隆中执行，不继承作者环境文件、知识库和位置记录。基础安装与启动不需要 Docling；解析能力缺失应明确提示。故障注入与迁移只针对临时库。

使用固定版本的 Gitleaks 对发布目录与完整可达 Git 历史扫描，并使用本地凭据做精确匹配；使用 `--redact=100`，不要输出实际值。例外只能限定已核实的合成字符串与文件，不能整体排除测试。目录扫描前清除或排除依赖和构建产物；这些产物也不应进入提交。

```bash
gitleaks git --redact=100 --log-opts="--all"
```

若发现真实凭据，先撤销并重新生成，再处理提交；删除当前文件不能消除历史泄露。扫描属于辅助检查，不保证不存在所有未知凭据形式。最终结果和限制记录于 [validation.md](validation.md)。

## 发布首版

本地开发仓库与公开首版仓库独立；不复制原 `.git`，不推送知识库内部 Git。使用 GitHub noreply 作者邮箱，不修改全局 Git 身份。

确定 GitHub 仓库地址后推送已验收提交，启用 Actions 和私密漏洞报告，检查 macOS/Linux 首轮 CI。通过后标记 `v0.1.0` 并创建 Release，注明正式支持平台、运行环境、配置和备份方式，以及未验收能力。
