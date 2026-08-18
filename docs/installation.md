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
