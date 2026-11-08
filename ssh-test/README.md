# Claude Code SSH 测试容器

用于测试 Claude Notify 的远程 SSH 部署、审批回调，以及终端 tab 状态。

本目录位于仓库根目录的 `ssh-test/`。`build.sh` 会在这里生成 `id_ed25519`、
`id_ed25519.pub`、`password.txt`，这三个文件已加入 `.gitignore`，**不要提交或外发**。
项目文档中的用法见 `desktop/E2E.md` 的「远程 SSH 部署（Docker 容器）」。

## 快速开始

前置条件：

- Docker 正在运行
- 宿主机 Claude 路由监听 `127.0.0.1:3456`
- Claude Notify 应用监听 `18765`
- `~/.claude-code-router/bin/ccr-claude-code-api-key-default-claude-code` 可执行

```bash
cd ssh-test
./build.sh    # 构建镜像、创建容器、注入公钥与模型配置、启动反向隧道
./stop.sh     # 删除容器并关闭隧道
```

`build.sh` 会输出本次生成的密码；也可以直接查看 `password.txt`。

## 连接信息

```text
host:     127.0.0.1
port:     2222
user:     claude
password: 见 password.txt
```

SSH：

```bash
ssh -p 2222 claude@127.0.0.1
```

免密 key：

```bash
ssh -i id_ed25519 -p 2222 claude@127.0.0.1
```

容器内 Claude Code 版本：`2.1.319`，命令在 `/usr/local/bin/claude`。

## 反向隧道

容器需要两个回连宿主机的能力：

- `127.0.0.1:3456` → 宿主机 Claude 路由（容器内 Claude 的模型调用）
- `127.0.0.1:18765` → 宿主机 Claude Notify 应用（审批/通知回调）

启动：

```bash
./start-tunnel.sh
```

停止：

```bash
./stop.sh
```

隧道断了以后，容器里的 `claude` 会连不上模型，审批回调也会失败；重新执行 `start-tunnel.sh` 即可。

## 在 Claude Notify 里部署

部署对话框填写：

```text
服务器地址: 127.0.0.1
SSH 端口:   2222
用户名:     claude
密码:       password.txt 里的值
回调 IP:    host.docker.internal
回调端口:   18765
来源标签:   docker-test
模式:       置顶弹窗 或 系统通知
终端 tab 状态: 勾选
```

`回调 IP` 也可以用 `127.0.0.1`（依赖 18765 反向隧道）；`host.docker.internal` 直接走 Docker 的宿主网关，已实测可达。

部署前先“测试连接”，确认主机指纹后点“部署并验证”。

## 验证 tab 状态

先手动验证 SSH 能把 OSC 标题透传到本地终端：

```bash
ssh -p 2222 claude@127.0.0.1
printf '\033]0;🟡 SSH\007\033]1;🟡 SSH\007\033]2;🟡 SSH\007'; sleep 5
```

本地 iTerm2/Tabby 的 tab 在 5 秒内应变成 `🟡 SSH`，命令结束后被 shell 重置回去，这是正常的。

部署完成后：

```bash
ssh -p 2222 claude@127.0.0.1
claude
```

Claude 运行期间 tab 应显示：

```text
🟡 claude-code-notify
```

本轮结束后：

```text
🟢 claude-code-notify
```

## 容器管理

```bash
docker ps --filter name=claude-ssh-test
docker logs -f claude-ssh-test
docker restart claude-ssh-test
docker rm -f claude-ssh-test
```

容器重建后需要重新写入 SSH 公钥并重启隧道；完整构建命令见 `build.sh`。

## 说明

- SSH 只绑定在 `127.0.0.1:2222`，没有暴露到局域网。
- 容器里的 Claude 认证使用宿主机的 Claude 路由；token 写在容器的
  `/home/claude/.claude-api-key.sh`，没有放进本目录。
- 部署器会合并容器里的 `~/.claude/settings.json`，保留已有的
  `apiKeyHelper`、`model` 和 `env`。
