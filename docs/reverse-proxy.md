# Reverse Proxy & Cloudflare Tunnel

This guide helps you with setting up Outpost behind a reverse proxy or Cloudflare Tunnel. Make sure WebSocket support is
enabled for it to work.

## Nginx

```nginx
server {
    listen 80;
    server_name outpost.yourdomain.com;

    location / {
        proxy_pass http://127.0.0.1:6989;
        proxy_http_version 1.1;
        
        # WebSocket support
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        
        proxy_read_timeout 86400;
    }
}
```

With SSL, add a redirect block and use `listen 443 ssl http2` with your cert paths.

## Apache

Enable modules first:

```sh
sudo a2enmod proxy proxy_http proxy_wstunnel rewrite
```

```apache
<VirtualHost *:80>
    ServerName outpost.yourdomain.com

    ProxyPreserveHost On

    # WebSocket
    RewriteEngine On
    RewriteCond %{HTTP:Upgrade} websocket [NC]
    RewriteCond %{HTTP:Connection} upgrade [NC]
    RewriteRule ^/?(.*) ws://127.0.0.1:6989/$1 [P,L]

    ProxyPass / http://127.0.0.1:6989/
    ProxyPassReverse / http://127.0.0.1:6989/
    ProxyTimeout 86400
</VirtualHost>
```

## Caddy

```caddy
outpost.yourdomain.com {
    reverse_proxy 127.0.0.1:6989
}
```

Caddy handles WebSockets and SSL automatically.

## Traefik (Docker)

```yaml
services:
  outpost:
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.outpost.rule=Host(`outpost.yourdomain.com`)"
      - "traefik.http.routers.outpost.entrypoints=websecure"
      - "traefik.http.routers.outpost.tls.certresolver=letsencrypt"
      - "traefik.http.services.outpost.loadbalancer.server.port=6989"
```

## Cloudflare Tunnel

Cloudflare Tunnel lets you expose Outpost to the internet without opening inbound ports. Traffic flows through
Cloudflare's network, giving you DDoS protection and optional Zero Trust authentication.

### Prerequisites

- A Cloudflare account with an active domain
- `cloudflared` installed on your
  server ([download](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/))

### 1. Create a Tunnel

Log in to [Cloudflare Zero Trust](https://one.dash.cloudflare.com/) and go to **Networks** → **Connectors**.

1. Click **Create a tunnel**
2. Choose **Cloudflared** as the connector type
3. Give your tunnel a name (e.g., `outpost`)
4. Copy the installation command and run it on your server

### 2. Configure the Public Hostname

After creating the tunnel, add a public hostname:

| Field     | Value                          |
|-----------|--------------------------------|
| Subdomain | `outpost` (or your preference) |
| Domain    | Select your domain             |
| Type      | `HTTP`                         |
| URL       | `localhost:6989`               |

![Create Tunnel in Cloudflare Dashboard](/assets/cloudflare-tunnel-create.png)

Click **Save tunnel**. Your Outpost instance should now be accessible at `https://outpost.yourdomain.com`.