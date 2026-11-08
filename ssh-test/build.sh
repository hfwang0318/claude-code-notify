#!/bin/sh
set -e
cd "$(dirname "$0")"

if [ ! -f password.txt ]; then
  openssl rand -hex 8 > password.txt
  chmod 600 password.txt
fi
PASS=$(cat password.txt)

docker build --build-arg CLAUDE_PASSWORD="$PASS" -t claude-ssh-test .
docker rm -f claude-ssh-test >/dev/null 2>&1 || true
docker run -d --name claude-ssh-test --hostname claude-docker \
  -p 127.0.0.1:2222:22 claude-ssh-test

sleep 2

if [ ! -f id_ed25519 ]; then
  ssh-keygen -t ed25519 -f id_ed25519 -N '' -C 'claude-ssh-test'
fi
docker exec -i claude-ssh-test sh -c \
  'mkdir -p /home/claude/.ssh && cat >> /home/claude/.ssh/authorized_keys' \
  < id_ed25519.pub
docker exec claude-ssh-test sh -c \
  'chown -R claude:claude /home/claude/.ssh && chmod 700 /home/claude/.ssh && chmod 600 /home/claude/.ssh/authorized_keys'
docker exec claude-ssh-test ln -sf /home/claude/.local/bin/claude /usr/local/bin/claude

TOKEN=$(~/.claude-code-router/bin/ccr-claude-code-api-key-default-claude-code)
printf '#!/bin/sh\nprintf "%%s\\n" %s\n' "'$TOKEN'" > /tmp/claude-api-key.sh
docker exec -i claude-ssh-test sh -c \
  'cat > /home/claude/.claude-api-key.sh' < /tmp/claude-api-key.sh
rm -f /tmp/claude-api-key.sh

docker exec -i claude-ssh-test python3 - <<'PY'
import json
import pathlib

settings = pathlib.Path('/home/claude/.claude/settings.json')
data = json.loads(settings.read_text()) if settings.exists() else {}
data['apiKeyHelper'] = '/home/claude/.claude-api-key.sh'
data['model'] = 'DeepSeek/deepseek-flash'
env = data.setdefault('env', {})
env.update({
    'ANTHROPIC_BASE_URL': 'http://127.0.0.1:3456',
    'ANTHROPIC_MODEL': 'DeepSeek/deepseek-flash',
    'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC': '1',
    'CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT': '1',
    'API_TIMEOUT_MS': '3000000',
    'NO_PROXY': '127.0.0.1,localhost,::1',
})
settings.write_text(json.dumps(data, indent=2) + '\n')

state = pathlib.Path('/home/claude/.claude.json')
state_data = json.loads(state.read_text()) if state.exists() else {}
state_data['hasCompletedOnboarding'] = True
state_data.setdefault('theme', 'dark')
state.write_text(json.dumps(state_data, indent=2) + '\n')
PY

docker exec claude-ssh-test sh -c \
  'chown -R claude:claude /home/claude/.claude /home/claude/.claude-api-key.sh && chmod 700 /home/claude/.claude /home/claude/.claude-api-key.sh && chmod 600 /home/claude/.claude/settings.json'

./start-tunnel.sh

echo "ready: ssh -p 2222 claude@127.0.0.1"
echo "password: $PASS"
