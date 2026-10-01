# 贡献指南

感谢你帮助完善织识。首版面向 macOS 本机单用户使用，优先修复可靠性、资料完整性与首次配置问题。使用成熟方案，复用现有模块，避免为未确定的需求提前扩展架构。

## 开发环境

使用 `.node-version` 指定的 Node 和 `package.json` 指定的 pnpm：

```bash
pnpm install --frozen-lockfile
pnpm dev
```

日常资料与测试数据分开。开发使用独立目录，可在未提交的 `.env.local` 中指定 `WEAVE_VAULT` 和 `WEAVE_CONFIG_DIR`；不要复用重要知识库。真实模型调用可能产生费用。

修改 Next 相关代码前，阅读本版本 `node_modules/next/dist/docs/` 中的指南；现有版本的约定可能与旧版不同。

## 修改约定

- 阅读相关实现及测试，再小范围修改。业务写入经 `lib/vault/service.ts` 或现有服务层完成，保持文件、引用、索引和版本记录一致。
- 迁移文件随代码提交，不修改已发布迁移。数据库不只是索引，不能通过删库修复问题。
- 凭据只能进入服务端配置，设置 API 使用脱敏视图；环境变量覆盖值不能随偏好保存写入 SQLite。
- 新测试使用 `tests/setup.ts` 的临时知识库与模拟 provider，不依赖个人 `.env`、真实资料或外部付费模型。
- 界面沿用现有设计与组件，提供中文操作提示、键盘可达性和失败恢复入口。

## 提交前验证

```bash
pnpm lint
pnpm build
pnpm typecheck
pnpm test
pnpm exec playwright install chromium
pnpm test:e2e
```

提交 PR 时说明具体问题、修改后的行为、验证结果和兼容性影响。附截图时使用合成资料，移除个人路径、密钥和真实文档内容。不要提交知识库、数据库、环境文件或本机验收产物。

普通问题通过 GitHub Issue 报告，附版本、系统、重现步骤和脱敏错误信息。涉及凭据泄露或访问边界的问题按 [SECURITY.md](SECURITY.md) 处理。

贡献内容按项目 MIT 许可证提供，第三方代码需保留其许可与出处。
