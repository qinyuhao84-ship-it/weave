# 界面与流程验收

界面采用集中设计令牌与共享组件，支持亮暗主题、减少动态效果、键盘操作和窄屏。设计参考及归属见 [NOTICE](../NOTICE.md)，当前工程结构见 [架构说明](architecture.md)。

## 可复现检查

```bash
pnpm build
pnpm typecheck
pnpm exec playwright install chromium
pnpm test:e2e
```

浏览器使用临时知识库、隔离配置和模拟模型；截图、axe 报告和失败 trace 输出到 Git 忽略的测试产物目录，不读取日常浏览器资料。

| 测试 | 覆盖 |
| --- | --- |
| configuration / model-recovery | 无配置启动，模型增删改切换，旧会话恢复与表单焦点 |
| delivery | 导入、人工审阅、草稿保存、问答归档、清空与恢复、本机 API 边界 |
| interface | 主要页面、桌面与窄屏、亮暗主题、键盘、溢出与 axe 检查 |
| visual-quality | 长标题、连续字符、320–1920px 布局、低高度输入、图谱鼠标与键盘操作 |
| performance | 搜索失败重试、过期请求取消、模型列表按需探测 |
| chat-html / source-html | 文件隔离交互、全屏、焦点恢复、下载与手机布局 |

检查的是运行行为与可操作性。自动 axe 扫描和模拟尺寸不能替代真实触摸设备或真人屏幕阅读器；没有奖项或认证结论。最终执行数量和环境见 [验收记录](validation.md)。
