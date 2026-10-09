# 🚀 Installation

> [!WARNING]
> Outpost is still in beta. Please back up your data regularly and report any issues on [GitHub](https://github.com/gnmyt/Nexterm/issues).

## 🔐 Generate Encryption Key

Outpost requires an encryption key to securely store your data. You can generate a strong key using the following command:

```sh
openssl rand -hex 32
```

## Docker Images

Outpost is distributed as three Docker images:

| Image            | Description                                                                        |
|------------------|------------------------------------------------------------------------------------|
| `outpost/aio`    | **All-In-One** - server, client, and engine in a single container. Simplest setup. |
| `outpost/server` | **Server only** - Node.js backend + web client. Requires a separate engine.        |
| `outpost/engine` | **Engine only** - Connection service (SSH, VNC, RDP, Telnet).                      |

For simple deployments, use `outpost/aio`. For multi-network or distributed setups, deploy `outpost/server` with one or
more `outpost/engine` instances on different networks.

## 🐳 All-In-One (Simple Setup)

::: code-group

```shell [Host Network (Recommended)]
docker run -d \
  -e ENCRYPTION_KEY=aba3aa8e29b9904d5d8d705230b664c053415c54be20ad13be99af0057dfa23a \ # Replace with your generated key
  --network host \
  --name outpost \
  --restart always \
  -v outpost:/app/data \
  outpost/aio:latest
```

```shell [Bridge Network]
docker run -d \
  -e ENCRYPTION_KEY=aba3aa8e29b9904d5d8d705230b664c053415c54be20ad13be99af0057dfa23a \ # Replace with your generated key
  -p 6989:6989 \
  --name outpost \
  --restart always \
  -v outpost:/app/data \
  outpost/aio:latest
```

:::

> [!NOTE]
> **Host Network** is strongly recommended. It allows Outpost to access your host's network stack directly, which is required for features like Wake-on-LAN and connecting to servers via `localhost`. Only use **Bridge Network** if you specifically need network isolation.

## 📦 Docker Compose

### All-In-One

::: code-group

```yaml [Host Network (Recommended)]
services:
  outpost:
    image: outpost/aio:latest
    environment:
      ENCRYPTION_KEY: "aba3aa8e29b9904d5d8d705230b664c053415c54be20ad13be99af0057dfa23a" # Replace with your generated key
    network_mode: host
    restart: always
    volumes:
      - outpost:/app/data
volumes:
  outpost:
```

```yaml [Bridge Network]
services:
  outpost:
    image: outpost/aio:latest
    environment:
      ENCRYPTION_KEY: "aba3aa8e29b9904d5d8d705230b664c053415c54be20ad13be99af0057dfa23a" # Replace with your generated key
    ports:
      - "6989:6989"
    restart: always
    volumes:
      - outpost:/app/data
volumes:
  outpost:
```

:::

### Split Deployment (Server + Engine)

Use this when you need the engine on a different network or want to run multiple engines.

First, create a `config.yaml` for the engine:

```yaml
server_host: "server"
server_port: 7800
registration_token: ""
```

Then create your `docker-compose.yml`:

```yaml
services:
  server:
    image: outpost/server:latest
    environment:
      ENCRYPTION_KEY: "aba3aa8e29b9904d5d8d705230b664c053415c54be20ad13be99af0057dfa23a" # Replace with your generated key
    ports:
      - "6989:6989"
    restart: always
    volumes:
      - outpost:/app/data

  engine:
    image: outpost/engine:latest
    restart: always
    volumes:
      - ./config.yaml:/etc/outpost/config.yaml

volumes:
  outpost:
```

```sh
docker-compose up -d
```

### Browser Tabs (optional)

Browser tabs let an agent such as Claude Code open and operate a web page in an Outpost tab while you watch and take over. They need the `outpost-browser` container (Chromium under Xvfb plus a small launcher).

::: danger
The container's DevTools ports have **no authentication**. Whoever reaches them controls every open browser session, including logged-in profiles. Put the container on a Docker network of its own that only Outpost joins and never publish its ports. When the container runs on the same host, Outpost itself must not run with `network_mode: host`.
:::

```yaml
services:
  outpost:
    image: outpost/aio:latest
    environment:
      ENCRYPTION_KEY: "aba3aa8e29b9904d5d8d705230b664c053415c54be20ad13be99af0057dfa23a" # Replace with your generated key
    ports:
      - "6989:6989"
    restart: always
    volumes:
      - outpost:/app/data
    networks: [default, browser]

  outpost-browser:
    image: ghcr.io/callmetechie/outpost-browser:latest
    restart: always
    cap_drop: [ALL]
    security_opt: ["no-new-privileges:true"]
    mem_limit: 2g
    environment:
      ALLOWED_CLIENTS: outpost
    volumes:
      - outpost-browser-profiles:/profiles
      - outpost-browser-downloads:/downloads
    networks: [browser]

networks:
  browser: {}

volumes:
  outpost:
  outpost-browser-profiles:
  outpost-browser-downloads:
```

`ALLOWED_CLIENTS` (comma-separated host names or IPs) limits the launcher and the DevTools ports to the Outpost container; connections from any other address are dropped. Without it the container accepts every client that reaches it. Pages inside the browser are kept away from these ports by a Chromium policy the container writes at start, so the ports 9222, 9230-9269, 9300, 10222 and 10230-10269 are not available as `via` targets.

Then, as an administrator:

1. **Settings → Browser**: enable browser tabs, launcher address `http://outpost-browser:9300`, Outpost address seen from the container `outpost` (the service name).
2. Grant the **Browser Sessions** permission (`connect.browser`, off by default) to the accounts that may use it.
3. On the machine where Claude Code runs, with an API key of that account:

```bash
claude mcp add --transport http outpost https://<outpost>/api/mcp \
  --header "Authorization: Bearer <api-key>"
```

**Container on another machine.** Chromium and the JPEG stream are noticeable on weak hardware such as a DS918+; the container can run on a stronger machine on the same network. Then publish ports `9300`, `9222` and `9230-9269` only on an address that nothing but the Outpost server can reach (a firewall rule allowing only Outpost's IP), set the launcher address to that machine, and set the Outpost address to the Outpost server's LAN address. Set `ALLOWED_CLIENTS` to the Outpost server's address. CDP travels unencrypted and carries everything typed into the pages, passwords included; between machines, run it through WireGuard or an SSH tunnel instead of the plain LAN. Sessions opened with `via` need Outpost to run with `network_mode: host` in this setup: their listening port is opened on demand and is not published from a bridge network.

Sessions opened with `via` tunnel the page's host and port through an SSH server entry; the account also needs **Port Forwarding** (`connect.tunnel`) on that entry.

### 🌐 IPv6 Support

To connect to IPv6 servers from within the container using bridge networking, add the following to your existing `docker-compose.yml` (not needed for host network):

```diff
services:
  outpost:
+   networks:
+     - outpost-net

+networks:
+  outpost-net:
+    enable_ipv6: true
```
