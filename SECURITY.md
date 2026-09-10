# 安全策略

[English](SECURITY-en.md) | **中文**

## 支持版本

Uni LLM Bench 是自托管软件。建议始终运行最新发布版：安全修复合入 `main` 后随下一个 tag 发布。

| 版本 | 是否支持 |
| --- | --- |
| 最新发布版 | ✅ |
| 旧版本 | ❌（请升级） |

## 信任模型

Uni LLM Bench 定位为**单租户自托管**工具，不是多租户 SaaS：

- 任何能访问登录页的人都可以尝试认证，因此请把它当作私有基础设施——置于 VPN 或带 TLS 的反向代理之后，不要在没有这层保护的情况下直接暴露到公网。
- 系统只有**一个**用户账号，由 `AUTH_USERNAME` / `AUTH_PASSWORD` 配置。任何通过认证的人都拥有完整权限：可访问所有已配置的服务商、API 密钥与全部基准历史。
- 本工具会向你配置的所有 LLM 端点发起**出站**请求，把你的提示词、（视觉测试中）你提供的图片 URL 发送给这些第三方服务商。请不要配置你不信任其数据处理的端点。

## 凭据处理

服务商 API key 是本应用持有的最敏感数据。

- **静态加密** — key 在写入 SQLite 前用 AES 加密（见 `backend/src/utils/encryption.ts`），加密密钥由 `ENCRYPTION_SECRET` 派生；未设置时首次运行自动生成并持久化。
- **接口永不返回** — 服务商相关接口只暴露 `apiKeyMasked`（例如 `sk-…abcd`）。解密后的 key 仅在服务端使用，用于发起 provider 调用和「测试连接」。
- **不进 URL 与日志** — Gemini 适配器通过 `x-goog-api-key` 请求头发送 key，而不是 `?key=` 查询串，因此不会泄漏到访问日志。
- **备份** — SQLite 文件内含加密后的 key。请按对待密钥本身的谨慎程度来备份它，并**单独**备份 `ENCRYPTION_SECRET`：没有它，已存储的 key 无法恢复。

### 应用密钥

`JWT_SECRET`、`ENCRYPTION_SECRET`、`ENCRYPTION_SALT` 在 `.env` 中留空时，会在首次运行时自动生成并以 `0600` 权限持久化到 `backend/data`。密码用 bcrypt 哈希，bcrypt 自身为每个哈希生成独立盐值——因此不存在需要你管理的"密码盐"。

源码自带默认密钥常量，仅作兜底之用。仍在沿用默认值的部署会在启动时告警，且用默认密钥加密的 provider API key 会被透明地用部署的真实密钥重新加密。这些默认值在正常运行中绝不用于签名或加密。

## 内置防护

- JWT 认证，首次登录强制修改密码
- 登录限流（5 次 / 5 分钟）
- Helmet 安全响应头，含内容安全策略（CSP）
- SSE 与下载链接使用一次性 token，JWT 不出现在 query string
- token 存于 `sessionStorage`，关闭标签页即清除
- CORS 仅限配置的来源，默认同源
- 全量参数化 SQL（`better-sqlite3` 预编译语句）
- Docker 镜像以非 root 用户运行，并裁剪了开发依赖

## 部署建议

1. **立即修改默认密码。** `AUTH_PASSWORD` 默认为 `changeme`，应用会在首次登录时强制你修改。
2. **自行生成密钥** —— 生产环境请为 `JWT_SECRET` 与 `ENCRYPTION_SECRET` 生成独立密钥并妥善备份。
3. **在反向代理上终止 TLS**，并把 `CORS_ORIGIN` 设为你的真实域名。
4. **限制网络访问** —— 除非确有需要，保持实例私有。
5. **备份** `backend/data/benchmarks.db`（以及你的密钥文件）——它承载全部历史、配置与加密后的 key。

## 报告漏洞

请**不要**为安全问题公开开 issue。

请通过本仓库的 [GitHub Security Advisories](https://github.com/zj-unicom-ai/uni-llm-bench/security/advisories/new) 私下报告。

请附上：

- 问题描述与影响范围
- 复现步骤或概念验证
- 受影响的版本或 commit
- 建议的缓解措施（如有）

我们会尽量在数日内确认报告，并与你协作修复、商定披露时间。公开披露前，请给我们合理的修复窗口。
