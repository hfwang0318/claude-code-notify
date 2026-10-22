## 改动

<!-- 简述功能 / 修复，关联 issue 或截图 -->

## 验证

- [ ] `cd desktop && pnpm typecheck`
- [ ] `cd desktop && pnpm test`
- [ ] 涉及 hook / 审批弹窗 / 通知 / 多会话 / 本地或远端部署：`cd desktop && pnpm e2e:claude`
- [ ] 涉及界面：`cd desktop && pnpm capture`，检查 `artifacts/` 截图
- [ ] 涉及部署：在真实 SSH 目标或 Docker sshd 上验证
- [ ] 已在 PR 描述中记录未覆盖/跳过的验证项

> 真实 Claude E2E 没有可用 Claude 认证时会 SKIP；涉及上述关键路径时请在本地跑通并附上 `E2E PASS` 输出。
> 详细说明：[desktop/E2E.md](desktop/E2E.md)
