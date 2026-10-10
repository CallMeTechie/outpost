# 🔐 Vault

The vault keeps credentials in Outpost: website logins, API keys, SSH keys, database passwords and anything else a tool needs. AI agents such as Claude Code and Codex, running on your servers in Outpost terminals, can use these entries without ever seeing the value. Outpost inserts the secret itself and hands the agent only the result. Every use can require your approval, is limited to the servers you choose, and ends up in the audit log.

In this release, agents can use one kind of entry: a **login**, filled into a sign-in form in an Outpost browser tab (see [Browser Tabs & Claude](/browser-tabs)). The other types can already be stored and viewed; agent tools for them follow in later releases.

## 1. Create and set the vault key

The vault encrypts every value with its own key, `VAULT_KEY`. It is separate from `ENCRYPTION_KEY`. Generate a new one:

```sh
openssl rand -hex 32
```

The key is 64 hex characters. Set it as an environment variable or as the Docker secret `vault_key`:

::: code-group

```yaml [Environment variable]
services:
  outpost:
    environment:
      VAULT_KEY: "<64 hex characters>"
```

```yaml [Docker secret]
services:
  outpost:
    secrets:
      - vault_key

secrets:
  vault_key:
    file: ./vault_key.txt
```

:::

Outpost reads every file in `/run/secrets` and uses its name in upper case as the variable name, so the secret `vault_key` becomes `VAULT_KEY`. A value already set in the environment wins over the file.

Restart Outpost. **Settings → Vault** shows the state of the key:

| State | Meaning |
| - | - |
| Active | The vault is on. |
| Missing | No key, or not 64 hex characters. The vault is off: no navigation entry, no agent tools, agent keys are rejected with `401`, and the vault API answers `404`. |
| Mismatch | The key cannot decrypt what Outpost already stored with the previous key. The vault stays off, exactly as with a missing key, until the original key is back. |

Without a key, Outpost starts and behaves exactly as before.

> [!WARNING]
> Keep `VAULT_KEY` apart from your Outpost backups, for example in a password manager. Backups contain the vault entries encrypted. Restored without the same key, they cannot be read, and there is no way to recover them. Do not replace the key once entries exist: Outpost detects the mismatch and switches the vault off.

## 2. Permissions

| Permission | Scope | Allows |
| - | - | - |
| `vault.use` | System | Create personal entries and let your own agents use them. Off by default, marked dangerous. |
| `vault.manage` | Organization | Create, edit and delete the organization's entries. |
| `vault.reveal` | Organization | Show and copy the values of the organization's entries. Marked dangerous. |
| `settings.vault` | System | Open **Settings → Vault**. |

An agent may use an organization's entries as long as its account is an **active** member of that organization. Pending invitations do not count. No further permission is needed for that.

## 3. Entries

Once the vault is on, **Vault** appears in the main navigation for accounts with `vault.use` or an organization membership. The list has one tab per owner: your personal entries and one tab per organization.

| Type | Fields | Secret fields | Usable by agents |
| - | - | - | - |
| Login | username, allowed origins (`scheme://host[:port]`, at least one) | password | `browser_fill_credential` |
| API key | hosts, header name (default `Authorization`), header template (default <code v-pre>Bearer {{secret}}</code>) | token | not yet |
| SSH | username | private key and/or password, optional passphrase | not yet |
| Database | engine (`postgres`, `mysql`, `sqlite`), host, port, database, username | password | not yet |
| Other | – | value | not yet |

**Name.** The name is how agents refer to the entry: lower-case letters, digits, `.`, `-` and `_`, starting with a letter or digit, at most 64 characters, unique per owner. Agents see a personal entry as `<name>` and an organization entry always as `org:<organization id>/<name>`. That way an identifier never changes because an entry with the same name appears somewhere else.

**Applies to.** An agent sees an entry only on the servers it applies to. Combine any of:

- single servers,
- folders, including all their subfolders,
- tags (personal entries only, because tags belong to your account),
- **All servers** (for an organization entry: all servers of that organization).

The default is none: a new entry is invisible to every agent until you choose. Organization entries can only apply to servers and folders of the same organization. The agent's account must also still be allowed to open the server; once that access goes away, Outpost rejects the server's agent keys with `403`. A request without a server (an account API key or a signed-in session) sees only personal entries that apply to **All servers**.

**Approval required.** On by default. Every use by an agent then needs a click in an Outpost window, see [Approvals](#_5-approvals). Only a signed-in session can switch it off: saving an entry with approvals off through an account API key or during an impersonation session answers `403` ("Turning off approvals requires a signed-in session"). A fill requested during an impersonation session always asks for approval, even for entries with approvals off.

**Changing a target clears the values.** When you change the origins of a login, the hosts of an API key or the host of a database entry, Outpost deletes all stored values of that entry in the same step, and the dialog asks for them again. Otherwise someone who may edit an organization entry, but not see its values, could point it at a site of their own and let an agent fill the password there.

**Show and copy.** The list never carries values. **Show** fetches one value when you click it and hides it again after 30 seconds; **Copy** puts it on the clipboard. Both are available to the owner of a personal entry and, for organization entries, to members with `vault.reveal`. Every call is audited. Everyone else sees a note that the value can only be used by agents.

**Deleting.** Deleting an entry removes its values and bindings. Deleting an account or an organization deletes its entries. Deleting a server, folder or tag removes every binding to it, including the subfolders and servers deleted with a folder.

**Unreadable entries.** If a value can no longer be decrypted, the entry is shown as unreadable, the agent gets `vault.item_unreadable`, and the server log and the audit log name the entry.

## 4. Agent access

Agents sign in with an **agent key**. It belongs to one server, works only at the MCP endpoint `/api/mcp`, and by default only from that server's IP address. Every other Outpost API answers it with `403`. Outpost also rejects it with `401` while the vault is off, and with `403` once its account may no longer open the server. Agent keys do not expire; to rotate one, set up the access again, which replaces the old key. Agent keys are listed apart from your account API keys under **Settings → Account**.

### Before you start

Under **Settings → Vault**, set **Outpost address for agents**: the address under which your servers reach Outpost, for example `http://192.168.2.10:6989`. Outpost appends `/api/mcp`. While nothing is saved, the field suggests the address your browser uses; check that your servers reach Outpost under it before saving. Prefer an address on your LAN that reaches Outpost directly rather than through a public reverse proxy (see [time limits](#time-limits) and [section 6](#_6-reverse-proxy-and-trust-proxy)).

This address is the default. The setup dialog has its own field **Outpost address for this server**, so servers outside your LAN can use another address, for example a domain behind your reverse proxy, while LAN servers keep the direct one. The field is prefilled with the address of the last setup on that server, otherwise with the default. Without an address in either place, setup is disabled.

**IP binding by default** decides whether **Only from this server's IP** starts switched on in the setup dialog. Turn it off if Outpost cannot see the addresses requests come from (see [sender addresses behind Docker](#sender-addresses-behind-docker)); you can still switch it per server.

### Set up with one click

1. In the server list, right-click an SSH server and choose **Agent access…**. The entry exists only for SSH servers and only if you may use the vault.
2. Select **Claude Code**, **Codex** or both. Check **Outpost address for this server**. Leave **Only from this server's IP** on. Add extra address ranges in CIDR notation if the agent's requests come from another network, for example `10.0.0.0/24`. These settings are fixed for the key; to change them, revoke the access and set it up again.
3. Start the setup.

Outpost then:

- creates one key per agent, named `claude@<server>` and `codex@<server>`;
- runs the setup over SSH with the identity Outpost would use to open this server, and names the remote user in the result, for example "Set up for root";
- stores the key on the server in a short first command that makes no CLI or network call: the shell builtin `printf` writes it to `~/.config/outpost/key-<id>-<random>` (mode `600`, directory `700`). Every later command reads the key from that file, and the setup aborts before it changes anything if the file turns out empty. Outpost deletes the file when the setup ends, also when it fails;
- measures the address the server's requests arrive from (see [address check](#address-check));
- finds the CLI with `command -v` in a login shell and in `~/.local/bin`, `~/.claude/local` and `~/.npm-global/bin`;
- for **Claude Code**: runs `claude mcp add --scope user --transport http outpost <url> --header "Authorization: Bearer <key>"` with `umask 077` and then `chmod 600 ~/.claude.json`. `claude mcp add` takes the key as an argument, so it is visible in the process list for as long as that command runs. An existing `outpost` registration, for example the account key from [Browser Tabs & Claude](/browser-tabs), is removed first and the result says so. That old account key stays valid in Outpost until you delete it under **Settings → Account**;
- for **Codex**: writes `export OUTPOST_MCP_TOKEN=<key>` to `~/.codex/outpost.env` with mode `600`, adds the line `[ -f ~/.codex/outpost.env ] && . ~/.codex/outpost.env` to `~/.bashrc`, `~/.profile` and, if they exist, `~/.bash_profile` and `~/.zshrc` (each only once), and runs `codex mcp add outpost --url <url> --bearer-token-env-var OUTPOST_MCP_TOKEN`. This needs a current Codex CLI. Older releases that required an experimental flag for HTTP servers (`rmcp`) are not supported.

Afterwards:

- **Claude Code:** restart Claude Code and run `/mcp`. `outpost` should be connected. Ask Claude to call `vault_list`.
- **Codex:** start Codex in a **new shell**. Codex processes that are already running, and tmux sessions started before the setup, do not have the key in their environment. Then run `/mcp` in Codex.

Setting up the same server, agent and remote user again replaces your previous key once the new one works. If the server user already had an `outpost` registration with an account API key, the result says it was replaced; that account key stays valid until you delete it under API Keys.

### Address check

While the new key is not yet in use, Outpost lets the server call `GET <address from the dialog>/api/vault/agent-keys/probe` with it, using `curl` or else `wget`. The key goes to the tool from a temporary file with mode `600` that the command deletes afterwards, never on the tool's command line. Outpost stores the address the first request arrived from; later probe calls with the same key change nothing.

If that address differs from what the server's host name resolves to, the dialog says so and offers to add it, for example "Seen 172.17.0.1 instead of 192.168.2.40 — adopt as address range? Without adopting it, Outpost refuses the key." Typical causes are NAT, IPv6, and an agent on a Docker host whose requests reach an Outpost container through the Docker gateway. Accepting adds exactly the measured address as `/32` (IPv4) or `/128` (IPv6). This works once and only within 15 minutes of creating the key. If the measured address is the address your own browser reaches Outpost from, Outpost refuses to adopt it ("The measured address is the address of your browser; Outpost sees a proxy, not the server"): both requests then arrive through the same proxy, and the range would let in everyone behind it. Fix `TRUST_PROXY` (see [section 6](#_6-reverse-proxy-and-trust-proxy)) or use Outpost's LAN address as **Outpost address for agents**. Without it, the IP binding rejects the agent with `403`, and the audit log records `vault.agent_ip_denied`.

If the check fails (neither `curl` nor `wget`, or Outpost unreachable from the server), the result says so and the setup continues with the resolved addresses.

### Manual setup

If the automatic setup fails, for example because the CLI is missing or the SSH command failed, the dialog shows the finished command. Copy it and run it on the server in your own terminal, not inside an agent session, so the key does not end up in a transcript. Copying is what makes the key valid. The key is shown only in this dialog and only this once. Closing the dialog without copying deletes the key; a key that is never used or copied is deleted by the server after 15 minutes.

Use the command exactly as the dialog shows it. It is a `/bin/sh -c '...'` command (for Codex two of them, joined with `&&`) that replaces an existing `outpost` registration and adds the new one. For Codex it also writes `~/.codex/outpost.env` and the lines in your shell start files. The key is part of the command line, so it appears in the process list of that server while the command runs. The command starts with a space, which keeps it out of the bash history only with `HISTCONTROL=ignorespace` or `ignoreboth`. Otherwise remove the line from the history (`history -d`) or clear the history after pasting.

### Several Outpost accounts on one server user

A server user has one `outpost` registration per agent. If another Outpost account has already set up agent access for the same server and remote user, the dialog warns before the setup: the registration is replaced, and the agents of that user then act with your entries and your approvals. The other account's key remains in Outpost until it is revoked.

### Revoke

Revoke a key under **Settings → Account** in the agent keys section (**Edit** per server opens the setup dialog) or in the setup dialog itself. Revoking deletes the key at once; the agent loses access immediately. Outpost then removes the registration from the server, but only if it still carries this key. It compares the key prefix inside Outpost; nothing read from the server is passed on. If another account's key is registered by now, the registration stays, and the result says that the access is revoked while the registration on the server carries another account's key and stays in place.

If the identity used for the setup has been deleted in the meantime, or removing the registration fails or cannot be confirmed, the key is revoked anyway and the result shows the removal command with a copy button. Run it on the server in your own terminal. Deleting the server entry deletes its agent keys.

## 5. Approvals

When an agent wants to use an entry with **Approval required**, a card appears bottom right in every Outpost window of the account that owns the agent key, including popouts. For organization entries this is the same user, not the organization's admins. The card shows agent and server, entry and target, and the time left. A request from an impersonation session is marked "Requested from an impersonation session" and offers only **Once** and **Deny**.

| Answer | Effect |
| - | - |
| Once | Allows exactly one fill. |
| For this session | Allows this entry for the rest of the agent's MCP session (see below). Not offered for a request from an impersonation session; the server refuses it with `vault.session_not_allowed`. |
| Deny | Refuses. For 60 seconds the same agent gets `vault.approval_denied` for this entry at once, without a new card, even over a new MCP session. |

- Without an answer within 2 minutes, the agent gets `vault.approval_timeout`.
- If no Outpost window of the account is open, the agent gets `vault.approval_unavailable` at once. Keep a tab open while agents work. Windows of an impersonation session neither receive cards nor count as open.
- The first answer wins; the card disappears in all other windows.
- The card names the page the agent was on when it asked. Outpost checks the page again after your answer and fills it if it is on any of the entry's origins at that moment, which can be another of them than the one on the card.
- Each MCP session has at most one open request per entry (`vault.approval_pending`), and each agent key at most three open requests (`vault.approval_busy`).

### "For this session" and `/clear`

The session is the agent's MCP connection to Outpost, not the chat. `/clear` in Claude Code starts a new conversation over the same connection, so an approval "for this session" keeps applying to it. It ends when the agent process exits or reconnects, when Outpost restarts, or after 12 hours without activity. It also ends as soon as the entry changes: after any save of the entry, for example new origins, the next use asks again. To withdraw it earlier, quit the agent or revoke its key.

### Time limits

The agent's request stays open while the card waits, up to 2 minutes. Everything between the agent and Outpost has to allow that:

- **Reverse proxy:** `proxy_read_timeout` of at least 150 seconds in nginx (the example in [Reverse Proxy](/reverse-proxy) uses 86400), `ProxyTimeout` likewise in Apache. This applies to `/api/mcp` and to `/api/vault/agent-keys`, whose setup request waits for the SSH commands on the server.
- **Cloudflare:** proxied requests end after 100 seconds. Use Outpost's LAN address as **Outpost address for agents**.
- **Codex:** waits 60 seconds per tool call by default. Raise it in `~/.codex/config.toml`, in the section the setup created:

  ```toml
  [mcp_servers.outpost]
  tool_timeout_sec = 180
  ```

- **Claude Code:** if you set `MCP_TOOL_TIMEOUT`, keep it at `150000` (milliseconds) or more.

If the agent gives up earlier, Outpost withdraws the request at once: the card disappears, the audit log records `vault.approval_timeout` with reason `client_gone`, and a late answer fills nothing.

## 6. Reverse proxy and TRUST_PROXY

The IP binding compares the address a request comes from. Behind a reverse proxy, Outpost learns that address only from `X-Forwarded-For`, and `TRUST_PROXY` decides whose `X-Forwarded-For` it believes.

| `TRUST_PROXY` | Effect on agent keys |
| - | - |
| unset or `false` | Outpost uses the address of the connection. Right when nothing sits in between. Behind a proxy, every request seems to come from the proxy: agent keys of other servers are rejected, and the key of a server that is the proxy host itself is accepted from anywhere. |
| address list, e.g. `172.18.0.2` or `loopback` | Outpost believes `X-Forwarded-For` only on connections from these addresses. **Recommended behind a proxy.** Direct connections keep their real address. |
| hop count, e.g. `1` | Outpost believes the last hops of `X-Forwarded-For` from anyone. Safe only if Outpost is reachable **exclusively** through the proxy. Otherwise an agent that calls Outpost directly writes its own `X-Forwarded-For` and passes any IP binding. |
| `true` | Outpost believes every `X-Forwarded-For`. The IP binding is useless; **Settings → Vault** and the setup dialog warn. Do not use it. |

The address list is comma separated and takes addresses, CIDR ranges and the names `loopback`, `linklocal` and `uniquelocal`. In Docker, give the proxy container a fixed address or a network of its own, because every address in a trusted range can set `X-Forwarded-For`.

The simplest setup: point **Outpost address for agents** at Outpost's direct LAN address. Agents then do not pass the proxy at all. Servers outside the LAN get the proxy's address in the setup dialog instead, and `TRUST_PROXY` lists every proxy hop between them and Outpost, for example the gateway in your LAN and the reverse proxy's address in the VPN.

### Sender addresses behind Docker

With a published port (`ports: "6989:6989"`), Docker can replace the sender address with its own bridge gateway, so every request seems to come from the same `172.x` or `192.168.x.1` address. This happens when the connection goes through `docker-proxy`, the default on Synology and some other NAS systems. Then the IP binding cannot tell servers apart, and the address check reports your browser's address for every server.

To check, run `docker exec outpost cat /proc/net/tcp6` while a server is connected and look at the remote addresses on port 6989 (`1B4D`). If they all show the same gateway, either run Outpost with `network_mode: host`, or turn off **IP binding by default** and rely on the key alone. In host mode, Outpost no longer reaches the browser container by name: give the container a fixed address on its network (`ipv4_address`), set **Launcher URL** in the browser settings to that address (for example `http://172.31.99.2:9300`) and **Callback host** to the network's gateway (`172.31.99.1`), and set `ALLOWED_CLIENTS` of the browser container to that gateway address.

## 7. Security model and limits

- **Agents never receive a value.** No tool returns a secret, its length, a prefix or a hash. Outpost types the password into the page itself; the agent gets a confirmation.
- **The agent key is not secret from the agent.** Claude Code keeps it in `~/.claude.json`, Codex in its environment. The key only allows mediated actions, limited by the server binding, approvals and the audit log, and the IP binding makes it worthless outside its server.
- **Local users of the server.** The IP binding cannot tell users of the same server apart. Anyone with an account there can read the key from `~/.claude.json` or `~/.codex/outpost.env` if file permissions allow (root always can), and during the setup from the process list: for the milliseconds of the command that stores the key, and for the runtime of `claude mcp add`, whose `--header` needs the key as an argument. They can then use it from that server. Mounting `/proc` with `hidepid=2` removes the process list as a source on shared servers; it does not protect the key files from root. Set up agent access only on servers whose local users the account owner trusts with the vault entries.
- **The live picture is not protected by `vault.reveal`.** If you watch an agent fill a login in your own browser tab, the page's "show password" button reveals the value, even without `vault.reveal`. For the agent, Outpost blanks the field in every snapshot (`value="••••"`) and refuses screenshots while a filled field is unmasked. Outpost remembers the filled fields of a tab until the tab closes, so a filled field that comes back unmasked, for example when the page returns from the back/forward cache, locks screenshots again. If a filled field disappears, for example because a "show password" button swaps the input, the tab stays locked until its main frame navigates; after that a missing field no longer locks. The lock also spans the browser context: while a tab of the context holds filled fields and has not navigated since the fill, screenshots in the other tabs of that context (popups included) are refused as well.
- **Outpost's own session list is not scrubbed.** The browser session list in Outpost's interface shows URL and title of each session as they are, only in the windows of the account that owns the sessions. Like the live picture, it is your view, not the agent's: if a page puts the filled password into its address or title, you see it there, while the agent sees `••••`.
- **A browser context that received a password stays locked.** After a fill, `browser_evaluate` is refused in that browser context, including popups, and every text sent to the agent or written to the audit log (snapshots, `URL:`, titles, session lists, error messages) is scrubbed of the filled password, also in URL-encoded and form-encoded form. Outpost fills only in fresh sessions: not over `via`, not in the persistent profile, and not in a browser context in which `browser_evaluate` has ever run.
- **Selection and paste are locked.** A selected password ends up in the system's selection buffer, from where a middle click pastes it anywhere. Outpost therefore refuses the agent's middle click (`browser_click` with `button: "middle"`) in every session; your own clicks in the tab are not affected. To open a link in a new tab, the agent calls `browser_open` with the link's address instead. In a browser context that received a password, Outpost also refuses `browser_key` with a Control, Meta or Shift combination (Shift+Tab excepted) and `browser_click` with `clickCount` above 1. The agent gets `vault.input_locked`, and the audit log records `vault.input_locked`. Before typing, Outpost empties a field directly instead of selecting its content.
- **The page must match.** The password field and every frame above it must be on one of the entry's origins exactly (scheme, host, port). A foreign page that embeds the login is refused; if you want to allow an embedding, add the embedding origin.
- **"For this session" outlives `/clear`.** See [Approvals](#for-this-session-and-clear).
- **Impersonation.** Admins who sign in as another user see that user's entries but cannot show values, answer approvals, switch off **Approval required**, or set up or revoke agent access. Fills requested during impersonation always ask for approval: the card marks them, and they can only be approved once, never for the session. The admin cannot create API keys for that user during impersonation either (`403` "This action requires a signed-in session"), so no key outlives the impersonation. Device-code authorization (`/api/auth/device/authorize`) rejects API keys, and a device session created from an impersonation session is itself an impersonation session with the same limits. Every audit entry from an HTTP request of such a session, of any action, names the admin as `impersonatorId`; entries from WebSocket connections (terminal, SFTP, AI chat) do not carry it yet.
- **Leaving an organization** hides its entries at once, also for MCP sessions that are already running and for a request whose approval card is still waiting.
- **Agent keys open only ephemeral browser sessions.** `browser_open` with `profile: "persistent"` answers `INVALID_PROFILE` for an agent key before a browser starts, so an agent never sees the cookies and logins of your persistent profile.
- **Audit log.** Category Vault: `vault.item_create`, `vault.item_update`, `vault.item_delete`, `vault.reveal`, `vault.use`, `vault.use_denied`, `vault.approve`, `vault.deny`, `vault.approval_timeout`, `vault.agent_key_create`, `vault.agent_key_revoke`, `vault.agent_ip_denied`, `vault.item_unreadable`, `vault.evaluate_locked`, `vault.screenshot_locked`, `vault.input_locked`, `vault.persistent_not_allowed`. Entries name the vault entry, agent, server and target, never a value.
- **No master password.** Whoever controls the Outpost host or container, and with it `VAULT_KEY`, can decrypt the vault.

## 8. Content Security Policy

Outpost sends a Content Security Policy with the web client. It limits where the page may load scripts, styles, fonts and images from and where it may connect to. That matters for the vault: a foreign script running inside Outpost could fetch every value you are allowed to show.

The policy starts in **report-only** mode, with one exception: framing. Outpost sends `frame-ancestors 'self'` as an enforced `Content-Security-Policy` from the start, together with `X-Frame-Options: SAMEORIGIN`, because a report-only policy would never stop another site from embedding Outpost. Apart from that the browser blocks nothing; it reports what it would have blocked to `POST /api/csp-report`, and Outpost writes each report to its log as `CSP violation`, with page and blocked address shortened to origin and path (query strings removed), directive name, disposition, source file and line. Anything else in a report is dropped. The endpoint needs no sign-in and takes 30 reports per minute per address. Over HTTPS, browsers report through the Reporting API (`report-to`), over plain HTTP through `report-uri`.

Use Outpost normally for a while — terminals, remote desktop, the file editor, recordings, browser tabs and the vault. If the log shows no `CSP violation`, switch the policy on and restart Outpost:

```yaml
services:
  outpost:
    environment:
      CSP_ENFORCE: "true"
```

Outpost then sends the whole policy as `Content-Security-Policy` instead of `Content-Security-Policy-Report-Only`. If something stops working, remove the variable again and report the logged violation. Enforcing becomes the default by 2026-12-31; progress is tracked in [issue #16](https://github.com/CallMeTechie/outpost/issues/16).

| Directive | Value | Why |
| - | - | - |
| `default-src` | `'self'` | Everything not listed below, including frames and media, loads only from Outpost itself. |
| `script-src` | `'self' 'wasm-unsafe-eval'` | Scripts come only from Outpost's own bundle; the recording player compiles its terminal emulator from WebAssembly. |
| `style-src` | `'self' 'unsafe-inline'` | React sets inline `style` attributes, and the code editor and terminal add style elements at runtime; styles cannot run code. |
| `img-src` | `'self' data: blob:` | Avatars and thumbnails come from Outpost's API, small icons are inlined as `data:`, and a chosen avatar is previewed from a `blob:` address. |
| `font-src` | `'self' data:` | All fonts are bundled; small ones are inlined as `data:`. No font is loaded from Google or another CDN. |
| `connect-src` | `'self' ws://<host> wss://<host>` | API calls, translations and the WebSockets for terminals, remote desktop, files, browser tabs and the live state go to Outpost only. |
| `worker-src` | `'self' blob:` | The code editor starts its workers from a `blob:` address that loads Outpost's own worker scripts. |
| `object-src` | `'none'` | Outpost uses no plugins. |
| `base-uri` | `'self'` | An injected `<base>` element cannot redirect the bundle's relative addresses. |
| `form-action` | `'self'` | No form posts to another site. |
| `frame-ancestors` | `'self'` | No other site can embed Outpost and trick you into clicking, for example, an approval. Enforced in both modes, together with `X-Frame-Options: SAMEORIGIN`: Outpost cannot be embedded in a page of another origin, for example a dashboard. |

File previews other than PDF carry a policy of their own, `Content-Security-Policy: sandbox allow-scripts allow-forms allow-popups`. An HTML or SVG file from a server therefore runs isolated from Outpost even when its preview address is opened in a tab of its own, not only inside the preview window. PDF previews are left out because browsers do not start their PDF viewer in a sandboxed document.

The desktop app ships its own policy; this one applies to Outpost in the browser. The development server (`yarn dev`) sends none.

## 9. Tools

The vault adds two MCP tools. They appear next to the [browser tools](/browser-tabs#tools) when the vault is on and the account has `vault.use` or is an active member of an organization. `browser_fill_credential` additionally needs the **Browser Sessions** permission; without it, it behaves like an unknown tool.

| Tool | Purpose |
| - | - |
| `vault_list` | Lists the entries the caller may use, each with `item` (the identifier for `browser_fill_credential`), `owner` (`personal` or the organization's name), `type`, `description`, `username` or `host`, `origins` or `hosts`, `approvalRequired` and `usableBy` (the tools that can use this type today). Never a value. |
| `browser_fill_credential` | `{ item, passwordRef, usernameRef?, sessionId? }`. Fills username and password of a login entry into the fields `passwordRef` and `usernameRef` from `browser_snapshot`. Answers only that both were filled. |

`browser_fill_credential` checks, in this order: the entry is visible and a login; the browser session belongs to the caller and is not paused; no `browser_evaluate` has run in its browser context; the session does not use `via` or the persistent profile; the frame of the password field and all frames above it match an allowed origin; `passwordRef` is a password field and `usernameRef` a text, email or phone field; the approval, if required. After the approval Outpost checks once more, right before typing, because the session was free for other tools while the card waited: the agent key is still valid, the entry is still visible to it with the same type and origins, and the session checks pass again. If the entry disappeared in the meantime, for example because you left its organization, the agent gets `vault.item_unknown`; if its origins changed, `vault.origin_mismatch`. Nothing is typed in either case.

With an agent key, the browser tools see only the sessions this key opened and their popups. `browser_list` hides your own tabs and those of other agents, a foreign `sessionId` answers like an unknown one, also for `browser_fill_credential`, `via` is limited to the key's own server (`browser_open` with another server answers `VIA_NOT_ALLOWED`), and `browser_open` opens only ephemeral sessions (`INVALID_PROFILE` for `profile: "persistent"`).

| Error | Meaning and next step |
| - | - |
| `vault.item_unknown` | No such entry, or it does not apply to this server. Call `vault_list`. |
| `vault.wrong_type` | The entry is not a login. |
| `vault.item_unreadable` | The stored value cannot be decrypted. Ask the user to check the entry. |
| `vault.no_secret` | The login entry has no stored password. Ask the user to enter it in Outpost. |
| `vault.session_tainted` | `browser_evaluate` ran in this browser context. Open a new session with `browser_open` without `profile: "persistent"` and fill there. |
| `vault.via_not_allowed` | The session runs over `via`. Outpost never types a password into a tunneled page, not even through the key's own server. Open a session without `via`. |
| `vault.persistent_not_allowed` | The session uses the persistent profile. Only an account API key can reach this; agent keys cannot open such a session. Open an ephemeral session. |
| `vault.origin_mismatch` | The page or a frame above the field is not on an allowed origin. Navigate to the entry's login page. |
| `vault.not_password_field` | `passwordRef` is not an `<input type="password">`. Take a new snapshot and pick the password field. |
| `vault.bad_username_field` | `usernameRef` is not a text field on the same origin. |
| `vault.focus_lost` | The focus left the target field before typing; nothing was typed. Try again. |
| `vault.evaluate_locked` | Credentials were filled in this browser context, so `browser_evaluate` is refused. Use `browser_snapshot` and `browser_click`. |
| `vault.screenshot_locked` | A filled field is unmasked or gone, or another tab of the same browser context holds filled fields. Use `browser_snapshot`. |
| `vault.input_locked` | Credentials were filled in this browser context, so key combinations that select or copy text and multi-clicks are refused; a middle click is refused in every session. Use `browser_click` and `browser_type` on single fields; to open a link in a new tab, call `browser_open` with its address. |
| `vault.approval_unavailable` | No Outpost window is open to answer. Ask the user to open Outpost. |
| `vault.approval_pending` | A request for this entry is already waiting. Wait for it. |
| `vault.approval_busy` | Three requests of this agent are already waiting. |
| `vault.approval_denied` | The user denied the request. Do not retry within 60 seconds. |
| `vault.approval_timeout` | Nobody answered within 2 minutes. |
| `vault.client_gone` | The agent closed the request before the answer arrived; check its tool timeout. |
| `vault.rate_limited` | More than 20 attempts of `browser_fill_credential` within a minute from this caller. Refused and invalid calls count too. Wait a minute and try again. The audit log gets one row for this per minute. |

