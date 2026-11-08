#!/bin/sh
set -e
cd "$(dirname "$0")"

pkill -f "ssh .*2222.*-R 3456" 2>/dev/null || true
sleep 1

ssh -i id_ed25519 -p 2222 \
  -R 3456:127.0.0.1:3456 \
  -R 18765:127.0.0.1:18765 \
  -N -f \
  -o ExitOnForwardFailure=yes \
  -o StrictHostKeyChecking=no \
  -o UserKnownHostsFile=/dev/null \
  claude@127.0.0.1

echo "tunnel started"
