#!/bin/sh
set -e

if command -v systemctl >/dev/null 2>&1; then
    systemctl stop outpost-server.service 2>/dev/null || true
    systemctl disable outpost-server.service 2>/dev/null || true
fi

exit 0