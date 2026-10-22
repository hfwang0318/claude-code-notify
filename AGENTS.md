# Repository Agent Instructions

## E2E gate

This repository has a real Claude Code E2E suite. Do not report hook, approval,
notification, multi-session, or deployment work as complete based only on unit
tests or mocks.

Before finishing a task that touches any of:

- `desktop/resources/hooks/**`
- `desktop/src/main/server.ts`, `protocol.ts`, `index.ts`, `sessions.ts`
- `desktop/src/renderer/src/Popup.tsx`, `Inbox.tsx`, `App.tsx`
- deployment / approval transport / notification behavior

run:

```bash
cd desktop
pnpm typecheck
pnpm test
pnpm e2e:claude
```

The E2E starts real `claude` processes against an isolated app instance and
must not modify `~/.claude/settings.json`. If Claude is unavailable, the script
SKIPs; record that explicitly instead of claiming E2E passed.

See `desktop/E2E.md` for cases, isolation, troubleshooting, and how to add a
new case. Update that document when adding user-visible approval behavior.

## Privacy

Do not commit full desktop screenshots or E2E temp directories. Crop evidence to
the app window/popup before adding it under `desktop/preview/`.
