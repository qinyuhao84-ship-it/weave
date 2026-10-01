# 首版交付验收

功能源码验收基于 `183856c` 首版提交，日期为 2026-10-01。当时以独立根提交发布 306 个文件，未复制本地开发历史。后续补充项目介绍与 4 张合成演示截图，并修复 CI 根提交扫描范围和历史测试的 Git 身份夹具，未改变应用运行源码；当前文件范围见 [release-files.txt](release-files.txt)。改动与维护限制见 [release-audit.md](release-audit.md)，上线后的回归状态见 [GitHub Actions](https://github.com/qinyuhao84-ship-it/weave/actions)。

## GitHub 上线验证

公开仓库：[qinyuhao84-ship-it/weave](https://github.com/qinyuhao84-ship-it/weave)。功能与 CI 修复提交 `585e997` 的 [双平台回归与密钥扫描](https://github.com/qinyuhao84-ship-it/weave/actions/runs/36874861409)已全部通过：macOS / Ubuntu 的安装、lint、构建、类型检查、单元测试与浏览器验收，以及 Gitleaks 完整历史扫描。

匿名克隆可获取发布清单中的 312 个文件；公开网页、README 与 4 张截图可在未登录状态下访问。已启用 GitHub 密钥扫描、推送保护与私密漏洞报告。后续版本结果以 Actions 为准，不将本次通过作为所有平台或所有真实模型的支持承诺。

上线验收后仅补充本文档与项目介绍，运行源码、测试、依赖及 CI 配置均与已通过提交一致；没有改写已公开历史。

## 安装与运行

从独立发布仓库执行 `git clone` 到全新目录，以空 pnpm store 安装，去除作者的模型、解析和 Git 身份环境变量，没有复制 `.env*`、知识库或位置配置。初次安装下载 704 个当前平台包，SQLite 原生模块安装成功；随后同步最终锁文件并执行 frozen install。未使用作者的 pnpm 包缓存；系统编译工具和 Node 头文件缓存仍来自当前机器。

实际环境：macOS 15.7.4 / arm64、Node 26.3.1、pnpm 11.7.0、Next.js 16.3.6；浏览器使用已安装 Chrome 的隔离无界面进程。所有模型调用均为模拟响应或临时模拟服务。

| 验收 | 结果 |
| --- | --- |
| `pnpm install --frozen-lockfile` | 通过，锁文件无需修改 |
| `pnpm peers check` | 无 peer 不兼容 |
| `pnpm lint` | 通过，零警告 |
| `pnpm build` → `pnpm typecheck` | 生产构建和严格类型检查通过 |
| `pnpm test` | 44 个测试文件，728 项通过；独立克隆运行约 112 秒 |
| `WEAVE_E2E_BROWSER_CHANNEL=chrome pnpm test:e2e` | 16 项通过，约 66 秒 |
| SQLite 内存库探针 | 查询正常 |
| `pnpm db:generate` | 工具可运行，无 schema 差异、未产生迁移 |
| 无配置生产启动 | 临时空知识库自动创建，SQLite 初始化；无模型与 Docling 仍可打开词条页，可用性检查明确提示缺失 |
| API 访问边界 | 外站 Origin 与非回环 Host 均返回 403；旧 `/history` 入口重定向至 `/wiki` |
| 合成性能基准 | 300 / 1,000 词条脚本均通过，见 [原始数据与方法](performance-audit.md) |
| 文档链接与清单 | 本地文档链接有效，发布清单与提交文件一致 |

故障注入覆盖文件恢复再次失败、继续恢复其他快照，以及 Git 暂存恢复失败；新增模型探测回归覆盖原生 Claude 鉴权、错误脱敏与列表兼容行为。浏览器测试覆盖无配置首次使用、导入审阅、问答归档、清空恢复、亮暗主题、窄屏、键盘、搜索取消和 HTML 预览隔离。

完整测试通过后仅更新注释、性能报告元数据及中位数统计实现、验收文档；最终 lint、构建与类型检查已重新通过，性能脚本按当前统计定义重新运行。

## 公开范围与凭据

- 发布目录仅含代码、示例、测试、迁移、许可证和公开工程文档。未提交作者的环境文件、知识库、位置配置、SQLite、开发工作树、内部审计、构建或浏览器产物。
- 使用 Gitleaks 8.30.1 对纯发布文件与完整可达 Git 历史扫描，`--redact=100`，结果零命中；未添加自定义扫描例外或整体忽略测试。
- 对本地环境与只读保存配置中的凭据做精确匹配，并检查个人路径、位置配置和私人作者邮箱，未发现泄露。公开供应商模板经人工核验保留，不包含作者实际选择与请求头值。
- 公开提交的作者和提交者邮箱均为 GitHub noreply；保留 MIT 许可证作者署名，不改变全局 Git 配置。
- `pnpm audit` 检查生产、开发与可选依赖，当前零已知漏洞；历史旧 esbuild 问题已由限定 override 处理，生成工具通过验证。

扫描只能辅助发现已知模式与已知本地值，不能证明不存在所有未知形式的秘密。运行中的凭据仍可能保存在使用者的 SQLite 内，该文件及完整备份必须自行保护。

## 验收源码指纹

指纹包含上线后对 CI 与 Git 测试夹具的修正；应用运行源码未改变。

下列 SHA-256 对发布清单中除 `docs/` 和根目录 Markdown 文档外的文件计算，包含源码、脚本、测试、迁移、依赖、配置及 CI；独立克隆与公开目录一致。指纹用于对应本轮检查结果，不替代签名或后续版本验收。

`ac50145a22923efd689f18fc4aa95c48d0b7c1ecda14dce84c71fd48c19be47f`

复算方法（在干净提交中执行）：

```python
import hashlib
import subprocess
from pathlib import Path

names = subprocess.check_output(["git", "ls-files", "-z"]).decode().split("\0")
digest = hashlib.sha256()
for name in sorted(filter(None, names)):
    if name.startswith("docs/") or ("/" not in name and name.endswith(".md")):
        continue
    digest.update(name.encode())
    digest.update(b"\0")
    digest.update(hashlib.sha256(Path(name).read_bytes()).digest())
print(digest.hexdigest())
```

## 未完成或不支持的验证

- Linux 已通过 CI 自动回归；macOS 仍为首版正式支持平台。Windows 不在首版正式支持范围。
- 未调用真实模型、安装完整 OCR 或发送个人资料；模拟测试不证明回答质量，数字 PDF 之外的解析能力需单独验收。
- 仍有大型工作区与流水线；文件、SQLite 和 Git 不提供断电级跨系统原子事务。只支持本机单用户、单应用进程。
- 公开默认配置不包含认证体系，不能直接作为多人或公网服务上线。下一步推送 GitHub 代码后需检查首次 CI；网站部署不属于此次交付。
