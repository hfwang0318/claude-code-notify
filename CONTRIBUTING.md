# Contributing

## 开发

```bash
cd desktop
pnpm install
pnpm dev
```

## 测试分层

| 层级 | 命令 | 用途 |
|---|---|---|
| 类型 | `pnpm typecheck` | 主进程 / preload / renderer / shared |
| 单测与集成 | `pnpm test` | HTTP 协议、settings 合并、本机接入、会话/风险/规则纯函数 |
| 协议冒烟 | `pnpm self-test` | 不依赖 Claude 的 HTTP 端到端 |
| 真实 Claude E2E | `pnpm e2e:claude` | 真实 hook、真实弹窗、真实会话 |
| 视觉回归 | `pnpm capture` | 主窗口、收件箱、历史、日志、设置、部署、弹窗截图 |

## 什么时候必须跑真实 E2E

只要改动涉及以下任一项，合并前必须跑 `pnpm e2e:claude`：

- 服务器端 hook 脚本、payload 字段、权限/问题协议
- 审批弹窗、会话条、收件箱、通知、超时/回退
- 多会话队列、限流/准入、history/session 持久化
- 本机接入、远端部署、resolved 同步

如果当前环境没有已登录的 Claude Code，E2E 会 SKIP。不要把它写成 PASS；在 PR 中说明跳过原因，并在有认证的环境补跑。

完整用例、隔离机制、排查方式和新增用例模板见 [desktop/E2E.md](desktop/E2E.md)。

## 提交前

```bash
cd desktop
pnpm typecheck
pnpm test
pnpm e2e:claude   # 涉及审批/hook/部署时
```

不要把 E2E 临时目录、token、完整桌面截图提交进仓库。
