# 🌐 Browser Tabs & Claude

Outpost can open real web pages as tabs. Chromium runs in a separate container and streams its picture into the tab. You can scroll, click and type in it like in any browser. An AI agent such as Claude Code can drive the same tab through Outpost's MCP endpoint. You watch every step live, can pause the agent, and can take over at any time.

## 1. Run the browser container

Add the browser service next to Outpost in your `docker-compose.yml`. Both share a Docker network of their own. The browser container publishes no port: its DevTools port has no authentication.

```yaml
services:
  outpost:
    # ... your existing service ...
    networks: [default, browser]

  outpost-browser:
    container_name: outpost-browser
    image: ghcr.io/callmetechie/outpost-browser:latest
    restart: unless-stopped
    cap_drop: [ALL]
    security_opt: ["no-new-privileges:true"]
    mem_limit: 1536m
    environment:
      ALLOWED_CLIENTS: outpost   # service name of Outpost
    volumes:
      - browser-profiles:/profiles
      - browser-downloads:/downloads
    networks: [browser]

networks:
  browser: {}

volumes:
  browser-profiles:
  browser-downloads:
```

Then run `docker compose pull && docker compose up -d`.

## 2. Enable browser tabs in Outpost

Under **Settings → Browser**:

| Field | Value |
| - | - |
| Enable browser tabs | on |
| Launcher address | `http://outpost-browser:9300` |
| Outpost address seen from the container | the **service name** of Outpost in the compose file, e.g. `outpost` |

> [!WARNING]
> The Outpost address must be the compose service name. A wrong name only shows up when you use `via`: the page fails with `ERR_NAME_NOT_RESOLVED`.

Then give the account the system permission **Browser Sessions**. It is off by default because a browser session reaches every address the browser container reaches.

After a reload, a globe icon appears in the main navigation. It opens a new browser tab with your persistent profile.

## 3. Connect Claude Code

Claude needs an API key of **your own account**. Outpost shows a browser tab only to the account that owns the session. With a separate account for Claude you would not see its tabs. A key carries the permissions of its account. The audit log records each agent action with its tool name, e.g. `browser_click`.

1. In Outpost, open **Settings → Account → API keys** and create a key, e.g. `claude-<machine>`. The token is shown only once and starts with `outpost_`. Keys from before the rename start with `nxt_` and keep working.
2. On the machine where Claude Code runs, register the MCP server. Do this in your own terminal, not inside a Claude session, so the key does not end up in a transcript:

   ```bash
    claude mcp add --scope user --transport http outpost http://<outpost-host>:6989/api/mcp --header "Authorization: Bearer outpost_<token>"
   ```

   The leading space keeps the command out of the shell history when `HISTCONTROL=ignorespace` is set. With `--scope user`, the key is stored in `~/.claude.json`, and the tools are available in every project.
3. Restart Claude Code and run `/mcp`. `outpost` should be connected. To test it, ask Claude to "open example.com in the Outpost browser". The tab appears in Outpost by itself.

To revoke access, delete the key under **Settings → Account → API keys**.

## Tools

| Tool | Purpose |
| - | - |
| `browser_open` | Open a URL in a new tab. `profile: "persistent"` keeps cookies across sessions. `via: "<server entry>"` tunnels the URL's host through an SSH server, for dev servers on that machine's `localhost`; needs the permission to create tunnels through that server and cannot be combined with the persistent profile. |
| `browser_list` | List the open sessions of the account, including tabs the user opened. |
| `browser_snapshot` | Return the accessibility tree with `[ref=eN]` markers. |
| `browser_click`, `browser_type`, `browser_key`, `browser_scroll` | Act on the page with real input events. |
| `browser_navigate`, `browser_wait`, `browser_screenshot` | Navigate, wait for a condition, capture a PNG. |
| `browser_evaluate` | Run a JavaScript expression. Every call is audited with its expression. |
| `browser_close` | End the session; its tab closes for the user as well. |

With exactly one open session, `sessionId` can be left out. Otherwise Claude has to pick one from `browser_list`. This is also how Claude takes over a tab you opened yourself.

## Good to know

- **Closing a tab is not ending the session.** The X on the tab only hides it; reload Outpost to get it back. The power button in the address bar ends the session.
- **Pause.** The pause button in the address bar blocks every agent tool until you resume. Your own input keeps working.
- **Several viewers.** The first viewer decides the page width; others see a scaled picture. When the first viewer leaves, the next one takes over.
- **Persistent profile.** Cookies with an expiry date survive. Session cookies (logins without "remember me") are lost once no persistent tab has been open for a minute, as in any browser that is quit.
- **Idle end.** A session without viewers and without agent activity ends after the idle timeout (default 30 minutes).
- **Resources.** Every session is a Chromium window. Ad-heavy pages can use several hundred MB of memory. Keep `mem_limit` in mind on small hosts.
