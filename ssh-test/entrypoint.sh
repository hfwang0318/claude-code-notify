#!/bin/sh
set -e

ssh-keygen -A
mkdir -p /run/sshd
exec /usr/sbin/sshd -D -e
