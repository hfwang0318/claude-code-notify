#!/bin/sh
pkill -f "ssh .*2222.*-R 3456" 2>/dev/null || true
docker rm -f claude-ssh-test 2>/dev/null || true
echo "stopped"
