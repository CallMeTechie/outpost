#!/bin/sh
set -e

if ! getent group outpost >/dev/null 2>&1; then
    groupadd --system outpost
fi
if ! getent passwd outpost >/dev/null 2>&1; then
    useradd --system --gid outpost --home-dir /var/lib/outpost-server \
        --shell /usr/sbin/nologin --comment "Outpost" outpost
fi

mkdir -p /etc/outpost-engine
chown root:outpost /etc/outpost-engine
chmod 0770 /etc/outpost-engine
if [ -f /etc/outpost-engine/config.yaml ]; then
    chown outpost:outpost /etc/outpost-engine/config.yaml
    chmod 0660 /etc/outpost-engine/config.yaml
fi

if command -v systemctl >/dev/null 2>&1; then
    systemctl daemon-reload || true
    systemctl enable outpost-engine.service || true
fi

ldconfig 2>/dev/null || true

exit 0
