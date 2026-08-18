#!/bin/sh
set -e

if ! getent group outpost >/dev/null 2>&1; then
    groupadd --system outpost
fi
if ! getent passwd outpost >/dev/null 2>&1; then
    useradd --system --gid outpost --home-dir /var/lib/outpost-server \
        --shell /usr/sbin/nologin --comment "Outpost" outpost
fi

mkdir -p /var/lib/outpost-server
chown -R outpost:outpost /var/lib/outpost-server
chmod 0750 /var/lib/outpost-server

mkdir -p /etc/outpost-server
chown root:outpost /etc/outpost-server
chmod 0750 /etc/outpost-server
if [ -f /etc/outpost-server/server.env ]; then
    chown root:outpost /etc/outpost-server/server.env
    chmod 0640 /etc/outpost-server/server.env
fi

if command -v systemctl >/dev/null 2>&1; then
    systemctl daemon-reload || true
    systemctl enable outpost-server.service || true
fi

if ! grep -qE '^ENCRYPTION_KEY=..' /etc/outpost-server/server.env 2>/dev/null; then
    if command -v openssl >/dev/null 2>&1; then
        KEY=$(openssl rand -hex 32)
    else
        KEY=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')
    fi

    if [ -f /etc/outpost-server/server.env ] && grep -q '^#\s*ENCRYPTION_KEY=' /etc/outpost-server/server.env; then
        sed -i "s|^#\s*ENCRYPTION_KEY=.*|ENCRYPTION_KEY=$KEY|" /etc/outpost-server/server.env
    else
        printf '\nENCRYPTION_KEY=%s\n' "$KEY" >> /etc/outpost-server/server.env
    fi
    chown root:outpost /etc/outpost-server/server.env
    chmod 0640 /etc/outpost-server/server.env
    echo "Auto-generated ENCRYPTION_KEY in /etc/outpost-server/server.env"
fi

exit 0