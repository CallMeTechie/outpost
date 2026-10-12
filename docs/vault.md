# 🔐 Vault

The vault keeps credentials in Outpost: website logins, API keys, SSH keys, database passwords and anything else a tool needs. AI agents such as Claude Code and Codex, running on your servers in Outpost terminals, can use these entries without ever seeing the value. Outpost inserts the secret itself and hands the agent only the result. Every use can require your approval, is limited to the servers you choose, and ends up in the audit log.

Agents can use two kinds of entry. A **login** is filled into a sign-in form in an Outpost browser tab (see [Browser Tabs & Claude](/browser-tabs)). An **API key** serves three purposes: Outpost calls an HTTP API with it (`vault_http`), Outpost forwards Git traffic to a Git host with it, and Outpost types it into a field of a browser tab (`browser_fill_secret`). An **Other** entry can be typed into a browser field as well. An **SSH** entry lets an agent run commands on other machines and copy files to and from them (`ssh_exec`, `ssh_put`, `ssh_get`, see [SSH](#_4a-ssh)). Database entries can already be stored and viewed; agent tools for them follow in a later release.

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
| API key | hosts, header name (default `Authorization`), header template (default <code v-pre>Bearer {{secret}}</code>), read only, allow http, use for Git (Git username), fill origins | token (at least 4 characters) | `vault_http`, `git`, `browser_fill_secret` |
| SSH | username, targets (servers, free hosts), allow "For this session" | private key and/or password, optional passphrase | `ssh_exec`, `ssh_put`, `ssh_get` |
| Database | engine (`postgres`, `mysql`, `sqlite`), host, port, database, username | password | not yet |
| Other | fill origins | value | `browser_fill_secret` |

**SSH targets.** An SSH entry lists the machines it may log in to. A target is either a **server** from your server list or a **free host** written as `host[:port]` (port 22 when left out).

- A server target uses the host, port, jump hosts and engine of the server's own entry. The identity stored on that server entry is never used; the SSH entry brings its own user and secret. It needs the permission `connect.ssh` for that server.
- A free host connects through the default engine, without jump hosts. Adding one needs the permission `connect.direct`, which is off by default.
- Both are checked when you save, only for targets that are new in that save, and again on every call for the account behind the agent key.
- **Applies to** is a different setting: it decides from which server an agent sees the entry. The targets decide where the agent can log in.
- Changing the targets deletes the stored values of the entry, like the other target fields below. An entry may be saved without targets; the tools then answer `vault.no_targets`.
- **Allow "For this session"** (off by default) permits session approvals for this entry; only a signed-in session can switch it on. Without it, every call needs its own **Once**.

**Use by agents.** An API key and an Other entry carry switches that decide what agents may do with the value. All of them start switched off or empty.

| Switch | Default | Effect |
| - | - | - |
| Read only | off | `vault_http` sends only `GET` and `HEAD`; Git only fetches (clone, fetch, pull), a push is refused. |
| Allow unencrypted HTTP | off | `vault_http` may also call `http:` URLs. Off means `https:` only. The token then travels unencrypted over the network. |
| Use for Git | off | The Git proxy may use the entry for the entry's hosts. |
| Git username | `x-access-token` | The user name sent next to the token in Git's basic authentication. GitHub takes `x-access-token`, GitLab `oauth2`. Letters, digits, `.`, `_`, `@` and `-`, at most 64 characters. |
| May be filled in the browser on | empty | The origins (`scheme://host[:port]`, up to 20) where `browser_fill_secret` may type the value. Empty means nowhere, unless **Allow filling tokens on any page** under **Settings → Vault** is on (see [Fill anywhere](#_7-security-model-and-limits)). |

`hosts` of an API key apply to `vault_http` and to Git. A host is a name or `host:port`, compared exactly, without wildcards and without regard to case. A port in `hosts` matches only URLs with exactly that non-default port. Leave out the default port: the entry rejects `host:443` and `host:80` ("hosts: leave out the default port (80 or 443)"), because a URL on the default port has no port to compare. An existing entry with a token shorter than 4 characters keeps working in the list, but `vault_http` and Git refuse it with `vault.secret_too_short` before anything is sent; replace the token.

Any change to these switches or to the hosts ends a "For this session" approval for the entry, see [Approvals](#_5-approvals).

**Name.** The name is how agents refer to the entry: lower-case letters, digits, `.`, `-` and `_`, starting with a letter or digit, at most 64 characters, unique per owner. Agents see a personal entry as `<name>` and an organization entry always as `org:<organization id>/<name>`. That way an identifier never changes because an entry with the same name appears somewhere else.

**Applies to.** An agent sees an entry only on the servers it applies to. Combine any of:

- single servers,
- folders, including all their subfolders,
- tags (personal entries only, because tags belong to your account),
- **All servers** (for an organization entry: all servers of that organization).

The default is none: a new entry is invisible to every agent until you choose. Organization entries can only apply to servers and folders of the same organization. The agent's account must also still be allowed to open the server; once that access goes away, Outpost rejects the server's agent keys with `403`. A request without a server (an account API key or a signed-in session) sees only personal entries that apply to **All servers**.

**Approval required.** On by default. Every use by an agent then needs a click in an Outpost window, see [Approvals](#_5-approvals). Only a signed-in session can switch it off: saving an entry with approvals off through an account API key or during an impersonation session answers `403` ("Turning off approvals requires a signed-in session"). A fill requested during an impersonation session always asks for approval, even for entries with approvals off.

**Changing a target clears the values.** When you change the origins of a login, the hosts of an API key, the targets of an SSH entry or the host of a database entry, Outpost deletes all stored values of that entry in the same step, and the dialog asks for them again. Otherwise someone who may edit an organization entry, but not see its values, could point it at a site of their own and let an agent fill the password there.

**Show and copy.** The list never carries values. **Show** fetches one value when you click it and hides it again after 30 seconds; **Copy** puts it on the clipboard. Both are available to the owner of a personal entry and, for organization entries, to members with `vault.reveal`. Every call is audited. Everyone else sees a note that the value can only be used by agents.

**Deleting.** Deleting an entry removes its values and bindings. Deleting an account or an organization deletes its entries. Deleting a server, folder or tag removes every binding to it, including the subfolders and servers deleted with a folder.

**Unreadable entries.** If a value can no longer be decrypted, the entry is shown as unreadable, the agent gets `vault.item_unreadable`, and the server log and the audit log name the entry.

## 4. Agent access

Agents sign in with an **agent key**. It belongs to one server and by default works only from that server's IP address. The keys of Claude Code and Codex work only at the MCP endpoint `/api/mcp`; the key of **Git** works only under `/api/vault/git/`. Every other Outpost API, and the other endpoint, answers it with `403`. Outpost also rejects it with `401` while the vault is off, and with `403` once its account may no longer open the server. Agent keys do not expire; to rotate one, set up the access again, which replaces the old key. Agent keys are listed apart from your account API keys under **Settings → Account**.

### Before you start

Under **Settings → Vault**, set **Outpost address for agents**: the address under which your servers reach Outpost, for example `http://192.168.2.10:6989`. Outpost appends `/api/mcp`. While nothing is saved, the field suggests the address your browser uses; check that your servers reach Outpost under it before saving. Prefer an address on your LAN that reaches Outpost directly rather than through a public reverse proxy (see [time limits](#time-limits) and [section 6](#_6-reverse-proxy-and-trust-proxy)).

This address is the default. The setup dialog has its own field **Outpost address for this server**, so servers outside your LAN can use another address, for example a domain behind your reverse proxy, while LAN servers keep the direct one. The field is prefilled with the address of the last setup on that server, otherwise with the default. Without an address in either place, setup is disabled.

**IP binding by default** decides whether **Only from this server's IP** starts switched on in the setup dialog. Turn it off if Outpost cannot see the addresses requests come from (see [sender addresses behind Docker](#sender-addresses-behind-docker)); you can still switch it per server.

### Set up with one click

1. In the server list, right-click an SSH server and choose **Agent access…**. The entry exists only for SSH servers and only if you may use the vault.
2. Select **Claude Code**, **Codex**, **Git** or any combination. Check **Outpost address for this server**. Leave **Only from this server's IP** on. Add extra address ranges in CIDR notation if the agent's requests come from another network, for example `10.0.0.0/24`. These settings are fixed for the key; to change them, revoke the access and set it up again.
3. Start the setup.

Outpost then:

- creates one key per agent, named `claude@<server>`, `codex@<server>` and `git@<server>`. Without an API key that has **Use for Git** and applies to the server, the Git setup creates no key and says so;
- runs the setup over SSH with the identity Outpost would use to open this server, and names the remote user in the result, for example "Set up for root";
- stores the key on the server in a short first command that makes no CLI or network call: the shell builtin `printf` writes it to `~/.config/outpost/key-<id>-<random>` (mode `600`, directory `700`). Every later command reads the key from that file, and the setup aborts before it changes anything if the file turns out empty. Outpost deletes the file when the setup ends, also when it fails;
- measures the address the server's requests arrive from (see [address check](#address-check));
- finds the CLI with `command -v` in a login shell and in `~/.local/bin`, `~/.claude/local` and `~/.npm-global/bin`;
- for **Claude Code**: runs `claude mcp add --scope user --transport http outpost <url> --header "Authorization: Bearer <key>"` with `umask 077` and then `chmod 600 ~/.claude.json`. `claude mcp add` takes the key as an argument, so it is visible in the process list for as long as that command runs. An existing `outpost` registration, for example the account key from [Browser Tabs & Claude](/browser-tabs), is removed first and the result says so. That old account key stays valid in Outpost until you delete it under **Settings → Account**;
- for **Codex**: writes `export OUTPOST_MCP_TOKEN=<key>` to `~/.codex/outpost.env` with mode `600`, adds the line `[ -f ~/.codex/outpost.env ] && . ~/.codex/outpost.env` to `~/.bashrc`, `~/.profile` and, if they exist, `~/.bash_profile` and `~/.zshrc` (each only once), and runs `codex mcp add outpost --url <url> --bearer-token-env-var OUTPOST_MCP_TOKEN`. This needs a current Codex CLI. Older releases that required an experimental flag for HTTP servers (`rmcp`) are not supported.

Afterwards:

- **Claude Code:** restart Claude Code and run `/mcp`. `outpost` should be connected. Ask Claude to call `vault_list`.
- **Codex:** start Codex in a **new shell**. Codex processes that are already running, and tmux sessions started before the setup, do not have the key in their environment. Then run `/mcp` in Codex.

- **Git:** see the next section.

Setting up the same server, agent and remote user again replaces your previous key once the new one works. If the server user already had an `outpost` registration with an account API key, the result says it was replaced; that account key stays valid until you delete it under API Keys.

### Address check

While the new key is not yet in use, Outpost lets the server call `GET <address from the dialog>/api/vault/agent-keys/probe` with it, using `curl` or else `wget`. The key goes to the tool from a temporary file with mode `600` that the command deletes afterwards, never on the tool's command line. Outpost stores the address the first request arrived from; later probe calls with the same key change nothing.

If that address differs from what the server's host name resolves to, the dialog says so and offers to add it, for example "Seen 172.17.0.1 instead of 192.168.2.40 — adopt as address range? Without adopting it, Outpost refuses the key." Typical causes are NAT, IPv6, and an agent on a Docker host whose requests reach an Outpost container through the Docker gateway. Accepting adds exactly the measured address as `/32` (IPv4) or `/128` (IPv6). This works once and only within 15 minutes of creating the key. If the measured address is the address your own browser reaches Outpost from, Outpost refuses to adopt it ("The measured address is the address of your browser; Outpost sees a proxy, not the server"): both requests then arrive through the same proxy, and the range would let in everyone behind it. Fix `TRUST_PROXY` (see [section 6](#_6-reverse-proxy-and-trust-proxy)) or use Outpost's LAN address as **Outpost address for agents**. Without it, the IP binding rejects the agent with `403`, and the audit log records `vault.agent_ip_denied`.

If the check fails (neither `curl` nor `wget`, or Outpost unreachable from the server), the result shows a warning regardless of the IP binding: "web01 could not reach Outpost at https://192.168.2.10:6989. Check the address (http or https?) — until then no agent can connect." Without `curl` and `wget` it says instead that the address could not be checked. The setup still goes through with the resolved addresses. The most common cause is `https://` in front of Outpost's own port, which speaks only http; use `http://` there, or the https address of your reverse proxy.

The **?** next to the dialog title opens a short setup guide, including the steps for a GitHub token.

### Manual setup

If the automatic setup fails, for example because the CLI is missing or the SSH command failed, the dialog shows the finished command. Copy it and run it on the server in your own terminal, not inside an agent session, so the key does not end up in a transcript. Copying is what makes the key valid. The key is shown only in this dialog and only this once. Closing the dialog without copying deletes the key; a key that is never used or copied is deleted by the server after 15 minutes.

Use the command exactly as the dialog shows it. It is a `/bin/sh -c '...'` command (for Codex two of them, joined with `&&`) that replaces an existing `outpost` registration and adds the new one. For Codex it also writes `~/.codex/outpost.env` and the lines in your shell start files. The key is part of the command line, so it appears in the process list of that server while the command runs. The command starts with a space, which keeps it out of the bash history only with `HISTCONTROL=ignorespace` or `ignoreboth`. Otherwise remove the line from the history (`history -d`) or clear the history after pasting.

### Git

Git is the third agent in the setup dialog. It needs no CLI except `git` itself; if `git` is missing, the result says so and shows the command to copy. For each host of the entries with **Use for Git** that apply to the server, and for the key, the setup writes into `~/.gitconfig` of the remote user, the same way on every run:

```sh
git config --file "$HOME/.gitconfig" --replace-all url."<address>/api/vault/git/<host>/".insteadOf "https://<host>/"
printf '[http "%s"]\n\textraHeader = "%s"\n' "<address>/api/vault/git/" "Authorization: Bearer <key>" >> "$HOME/.gitconfig"
chmod 600 "$HOME/.gitconfig"
```

The file ends up with mode `600`. The first line exists once per host. Before it writes, the setup removes its own earlier lines (every `insteadOf` whose section name contains `/api/vault/git/`, and the `extraHeader`); other `insteadOf` rules stay. From then on, `git clone https://github.com/o/r.git` talks to Outpost, and Outpost talks to the Git host with the token. The token never reaches the server, and there is no credential helper in the Git process.

- **Hosts are fixed at setup.** Only hosts of entries with **Use for Git** that apply to the server at that moment are set up. After you add a host or enable another entry, set up Git again.
- **SSH remotes do not use the vault.** A remote such as `git@github.com:o/r.git` goes directly over SSH. Switch it to HTTPS: `git remote set-url origin https://github.com/o/r.git`. The setup dialog shows this note as soon as Git is selected.
- **Process list.** The key goes into `~/.gitconfig` through the shell's built-in `printf`, read from the key file, so unlike with `claude mcp add` it never shows up in the process list.
- **One entry per host.** If two entries with **Use for Git** apply to the same host on this server, Git answers `vault.git_ambiguous`. Restrict the binding of one of them.
- **Errors appear in Git.** A refusal shows up as `fatal: remote error: vault: <message> (<code>)`. A request that is not a plain smart-HTTP fetch or push is answered `404`: Outpost speaks neither dumb HTTP nor Git LFS.
- **Limits.** 30 Git operations per minute per Git key (`vault.rate_limited` above that) and at most 4 forwarded requests at the same time (`vault.busy`). Pushes and clones have no size limit and no time limit; only 60 seconds in which no data flows in either direction end a connection. A running read has no upper limit as long as requests keep coming within its window.
- **Operations.** A Git operation starts with the `info/refs` request of a command and includes the following requests to the same service and repository. It ends 60 seconds after the last of them. After Outpost refuses a `POST` of an operation, the operation is over; Git starts a new one with the next command.

Revoking the Git key removes only the lines the setup wrote and ends the Git session, so a "For this session" approval for Git lapses with it.

### Several Outpost accounts on one server user

A server user has one `outpost` registration per agent. If another Outpost account has already set up agent access for the same server and remote user, the dialog warns before the setup: the registration is replaced, and the agents of that user then act with your entries and your approvals. The other account's key remains in Outpost until it is revoked.

### Revoke

Revoke a key under **Settings → Account** in the agent keys section (**Edit** per server opens the setup dialog) or in the setup dialog itself. Revoking deletes the key at once; the agent loses access immediately. Outpost then removes the registration from the server, but only if it still carries this key. For Git the registration is the `extraHeader` line; the removal takes out the setup's own `insteadOf` and `extraHeader` lines. It compares the key prefix inside Outpost; nothing read from the server is passed on. If another account's key is registered by now, the registration stays, and the result says that the access is revoked while the registration on the server carries another account's key and stays in place.

If the identity used for the setup has been deleted in the meantime, or removing the registration fails or cannot be confirmed, the key is revoked anyway and the result shows the removal command with a copy button. Run it on the server in your own terminal. Deleting the server entry deletes its agent keys.

## 4a. SSH

An SSH entry gives an agent three tools: `ssh_exec` runs a command on a target, `ssh_put` and `ssh_get` copy one file. Outpost logs in itself, through its engine, with the entry's user and key or password. The agent never sees them. The tools need an entry with at least one target (see [SSH targets](#_3-entries)). `ssh_put` and `ssh_get` work only with an agent key that was set up on a server.

### Host keys

The first time an entry connects to a target, the approval card shows the host key's algorithm and fingerprint (`SHA256:…`) in a box **New target**, and always asks, even for an entry with **Approval required** off. Compare the fingerprint with the output of `ssh-keyscan -t <type> <host> | ssh-keygen -lf -`, where `<type>` is the algorithm shown on the card: `ed25519`, `ecdsa` or `rsa`. Outpost does not log in to the target before you approve. The file tools do connect to the agent's own server first, to check the local file.

- After the approval, Outpost remembers the key per entry and target. Two entries with the same target remember their keys separately.
- If the key differs later, the engine aborts before logging in: the agent gets `vault.host_key_changed`, you see the notice `Host key of <target> changed — connection aborted`, and there is no card. Open the entry and choose **Forget** on the target; the next connection shows the new fingerprint. **Forget** needs the right to reveal the entry and a signed-in session without impersonation, since the next approval sends the secrets to whatever answers at the target.
- A server entry whose host or port is edited keeps its remembered key. The same machine still matches; another machine ends in `vault.host_key_changed`.
- Jump hosts and the agent's own server (used by `ssh_put` and `ssh_get`) are not checked.
- The engine's libssh2 chooses the host key algorithm. After an engine update with another libssh2 version it may choose another algorithm, and every remembered key then reports `vault.host_key_changed`. Forget the key and confirm it again.

### Commands

`ssh_exec` has no terminal. Interactive programs and `sudo` with a password prompt do not work; for another user, create an entry for that user.

- `timeoutSec` is 1 to 600 seconds, 60 by default. When it runs out, the result says `(timed out after <n> s)`; the process on the target can keep running.
- Each output stream is cut at 64 KB. The engine itself delivers at most 256 KB per stream and nothing after a NUL byte; invalid UTF-8 is replaced.
- Outpost replaces the entry's password, passphrase and private key (also each line of the key) with `••••`. Values shorter than 4 characters are not replaced. Nothing else is replaced: whoever may run commands as `deploy` reads everything `deploy` can read, including other secrets in files.
- A target without an SFTP service still runs commands; file transfer does not work there.
- A command with control or bidi characters, also invisible ones, is refused (`vault.bad_command`), as is a path with them or with a line break (`vault.bad_path`). The card would otherwise show something different from what runs.
- If a call ends after the command was sent, `vault.ssh_failed` says so: the command may have run in full or in part. Check on the target before running it again. A cancelled call ends the running command in the engine; the process on the target may keep running.

### Files

`ssh_put` copies a file from the agent's server to a target, `ssh_get` the other way round. The content never passes through the agent. The file is at most 100 MB. On the agent's server, Outpost reads and writes as the same user for whom the agent access was set up; the agent gets no extra rights there.

- Paths are absolute or start with `~/`, at most 4 KB. `~/` becomes the home directory of the session's user.
- An existing destination is replaced only with `overwrite: true` (`vault.file_exists`).
- Outpost writes to a temporary file next to the destination, named `<destination>.outpost-<8 hex characters>.tmp`, created exclusively (an existing file of that name makes the call fail) with mode 0600, and renames it afterwards. The final mode is set on the open handle before it is closed: the mode of the source, or on replacing, the mode of the old file.
- If the target does not allow setting the mode (SMB/CIFS mounts, FAT, ACL-only shares), the file is still written, keeps mode 0600, and the result says "Permissions could not be set; the file keeps mode 0600."
- The owner of the new file is the entry's user on the target. When replacing, the old owner is lost.
- If the rename fails after the old file was deleted, the old file is gone and the result names the temporary file.
- The card for `ssh_get` shows the size only after approval, because Outpost logs in to the target only then. The transfer stops beyond 100 MB and removes the temporary file.
- File system errors come back as `vault.ssh_failed` with the SFTP status, for example `<path>: permission denied; nothing was copied.` If the temporary file stayed, the message names it.

### Upgrades

Engine and server come from the same release. The server refuses an engine of another version at its hello, and the host key check relies on this: an engine that skips the host key comparison can never be connected. After an update, update your engines too.

### Privileged users

Whoever may run commands as `root` on a target can capture later logins (PAM, sshd) and learn the entry's password. A key reveals only proof. For privileged users, use a key instead of a password.

## 5. Approvals

When an agent wants to use an entry with **Approval required**, a card appears bottom right in every Outpost window of the account that owns the agent key, including popouts. For organization entries this is the same user, not the organization's admins. The card shows agent and server, the tool, entry and target (for example `POST api.github.com/repos/o/r/issues`, `Git · github.com/o/r` or the page a field is filled on), and the time left. A request from an impersonation session is marked "Requested from an impersonation session" and offers only **Once** and **Deny**.

| Answer | Effect |
| - | - |
| Once | Allows exactly one use: one API call, one fill, or one Git operation. For a Git push it allows exactly one push (see below). |
| For this session | Allows this entry for the rest of the agent's session (see below), for the same kind of use. Not offered for a request from an impersonation session; the server refuses it with `vault.session_not_allowed`. |
| Deny | Refuses. For 60 seconds the same agent gets `vault.approval_denied` for this entry at once, without a new card, even over a new MCP session. The block covers the whole entry, reading and writing alike: whoever denies a write also blocks reading it for 60 seconds. |

### SSH

An SSH call follows **Approval required** of the entry. A new target always asks (see [Host keys](#host-keys)). The card names the target as `<name> · user@host:port` and carries the badge **executes** (red) for `ssh_exec`; `ssh_put` counts as writing, `ssh_get` as reading.

A command of more than 20 lines or 1200 characters appears collapsed (the first 20 lines, at most 1200 characters). **Once** and **For this session** become available only after **Show all**; **Deny** always works.

**For this session** is offered only when the entry allows it (**Allow "For this session"**). It then applies per target, kind (execute, write, read) and host key. An approval for `web02` does not cover `nas`, and none covers another host key.

### Reading and writing

An approval separates reading from writing. These count as **writing**: the `vault_http` methods `POST`, `PUT`, `PATCH` and `DELETE`, a Git push (`git-receive-pack`), and every fill in the browser. `GET`, `HEAD` and Git fetch count as reading. The card carries the badge **writes** for writing.

"For this session" applies per entry and per kind, and the three kinds are separate approvals:

- reading through `vault_http` or Git,
- writing through `vault_http` or Git,
- filling in the browser (`browser_fill_credential` and `browser_fill_secret`).

An approval to read an entry grants no write, and the approval to fill grants no API call. For an entry without its own fill origins (see [Fill anywhere](#_7-security-model-and-limits)), the fill approval covers only the page it was given for. `browser_fill_secret` into a field that is not a password field (text, search, url, textarea) can only be approved **Once**: the card names the field as the page labels it ("Fill in on https://github.com · field “Comment”") and offers no **For this session**, and an earlier session approval does not cover it. A session approval for such fields would cover every text field of the origin, including a comment box that publishes the value.

For Git, **Once** covers one operation: a clone, a fetch or a pull. For a push it covers exactly one push, and the push counts as used as soon as its pack data has gone to the Git host, even if the push fails after that. The next push opens a new card unless a session approval applies. Git's empty probe request before a push does not count.

- Without an answer within 2 minutes, the agent gets `vault.approval_timeout`.
- If no Outpost window of the account is open, the agent gets `vault.approval_unavailable` at once. Keep a tab open while agents work. Windows of an impersonation session neither receive cards nor count as open.
- The first answer wins; the card disappears in all other windows.
- The card names the page the agent was on when it asked. Outpost checks the page again after your answer and fills it if it is on any of the entry's origins at that moment, which can be another of them than the one on the card.
- Each MCP session has at most one open request per entry (`vault.approval_pending`), and each agent key at most three open requests (`vault.approval_busy`). For Git, the session is that of the Git key: while a card for an entry is open, a second Git operation with the same entry, for example the clone of another repository on the same host, answers `vault.approval_pending`.

### "For this session" and `/clear`

For Claude Code and Codex, the session is the agent's MCP connection to Outpost, not the chat. `/clear` in Claude Code starts a new conversation over the same connection, so an approval "for this session" keeps applying to it. It ends when the agent process exits or reconnects, when Outpost restarts, or after 12 hours without activity. It also ends as soon as the entry changes: after any save of the entry, for example new origins, the next use asks again. To withdraw it earlier, quit the agent or revoke its key.

Git has no MCP connection. Its session belongs to the Git key and ends after 12 hours without a Git request of that key, when the entry changes, and when you revoke the key.

### Time limits

The agent's request stays open while the card waits, up to 2 minutes. Everything between the agent and Outpost has to allow that:

- **Reverse proxy:** `proxy_read_timeout` of at least 150 seconds in nginx (the example in [Reverse Proxy](/reverse-proxy) uses 86400), `ProxyTimeout` likewise in Apache. This applies to `/api/mcp`, to `/api/vault/agent-keys`, whose setup request waits for the SSH commands on the server, and to `/api/vault/git/`, because the first Git request of an operation waits for the card.
- **Reverse proxy and Git uploads:** a push sends a body of any size. `/api/vault/git/` and `/api/mcp` need a body limit that allows it, and Git needs requests that are not buffered. In nginx:

  ```nginx
  location /api/vault/git/ {
      client_max_body_size 0;
      proxy_request_buffering off;
      proxy_read_timeout 150s;
  }
  ```

  Set the same `client_max_body_size 0;` (or a sufficient limit) for `/api/mcp`, whose `vault_http` bodies reach 1 MB. Take the other `proxy_*` settings of your normal location over into these blocks.
- **`vault_http`:** one call, from the approval onward, takes at most 30 seconds. The wait for the card does not count.
- **Git:** uploads and downloads have no time limit. Outpost ends a connection after 60 seconds without data in either direction.
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

- **Agents never receive a value.** No tool returns a secret, its length, a prefix or a hash. Outpost types the password into the page itself, sends the API request itself and talks to the Git host itself; the agent gets a confirmation or the response.
- **The agent key is not secret from the agent.** Claude Code keeps it in `~/.claude.json`, Codex in its environment, Git in `~/.gitconfig`. The Git key works only at the Git proxy, only from the server's IP address, only with approval and only for entries that apply to that server. The key only allows mediated actions, limited by the server binding, approvals and the audit log, and the IP binding makes it worthless outside its server.
- **Local users of the server.** The IP binding cannot tell users of the same server apart. Anyone with an account there can read the key from `~/.claude.json` or `~/.codex/outpost.env` if file permissions allow (root always can), and during the setup from the process list: for the milliseconds of the command that stores the key, and for the runtime of `claude mcp add`, whose `--header` needs the key as an argument. They can then use it from that server. Mounting `/proc` with `hidepid=2` removes the process list as a source on shared servers; it does not protect the key files from root. Set up agent access only on servers whose local users the account owner trusts with the vault entries.
- **The live picture is not protected by `vault.reveal`.** If you watch an agent fill a login in your own browser tab, the page's "show password" button reveals the value, even without `vault.reveal`. For the agent, Outpost blanks the field in every snapshot (`value="••••"`) and refuses screenshots while a filled field is unmasked. Outpost remembers the filled fields of a tab until the tab closes, so a filled field that comes back unmasked, for example when the page returns from the back/forward cache, locks screenshots again. If a filled field disappears, for example because a "show password" button swaps the input, the tab stays locked until its main frame navigates; after that a missing field no longer locks. The lock also spans the browser context: while a tab of the context holds filled fields and has not navigated since the fill, screenshots in the other tabs of that context (popups included) are refused as well.
- **Outpost's own session list is not scrubbed.** The browser session list in Outpost's interface shows URL and title of each session as they are, only in the windows of the account that owns the sessions. Like the live picture, it is your view, not the agent's: if a page puts the filled password into its address or title, you see it there, while the agent sees `••••`.
- **A browser context that received a password stays locked.** After a fill, `browser_evaluate` is refused in that browser context, including popups, and every text sent to the agent or written to the audit log (snapshots, `URL:`, titles, session lists, error messages) is scrubbed of the filled password, also in URL-encoded and form-encoded form. Outpost fills only in fresh sessions: not over `via`, not in the persistent profile, and not in a browser context in which `browser_evaluate` has ever run.
- **Selection and paste are locked.** A selected password ends up in the system's selection buffer, from where a middle click pastes it anywhere. Outpost therefore refuses the agent's middle click (`browser_click` with `button: "middle"`) in every session; your own clicks in the tab are not affected. To open a link in a new tab, the agent calls `browser_open` with the link's address instead. In a browser context that received a password, Outpost also refuses `browser_key` with a Control, Meta or Shift combination (Shift+Tab excepted) and `browser_click` with `clickCount` above 1. The agent gets `vault.input_locked`, and the audit log records `vault.input_locked`. Before typing, Outpost empties a field directly instead of selecting its content.
- **Responses.** In `vault_http` responses and in text responses of a Git host, Outpost replaces the token with `••••`: as it is, percent- and form-encoded, JSON-escaped, in base64, and as the finished header value. For Git this covers every answer that is not `application/x-git-*` data, so also error pages of the host; pack data is not changed. A service that returns the token transformed is not caught: a byte range of it, `\u`-escaped, hashed, reversed. List only hosts whose APIs do not reflect the `Authorization` header. And whatever data a service shows for this token, the agent sees: whoever may call `api.github.com` reads what GitHub shows this token. Redirects to another origin are not followed, so the token never goes there.
- **Fill anywhere.** **Settings → Vault → Allow filling tokens on any page** lets `browser_fill_secret` type values of entries without fill origins into any page: personal entries always, an organization's entries only for members who may reveal them (`vault.reveal`), because a page of the member's own choosing could read the value. Every fill then asks for approval, even for entries with **Approval required** off, and a session approval covers only the one page it was given for. The risk: an agent can steer a browser tab to a page of its own and let you approve the token there; read the card's target. Leave the switch off and list fill origins per entry instead.
- **Proxy environment.** Node's `fetch` and `node:https` use `HTTP_PROXY` and `HTTPS_PROXY` only if `NODE_USE_ENV_PROXY=1` is set. Outpost does not set it; if you set it on the Outpost container, the token travels through that proxy.
- **The page must match.** The password field and every frame above it must be on one of the entry's origins exactly (scheme, host, port). A foreign page that embeds the login is refused; if you want to allow an embedding, add the embedding origin.
- **"For this session" outlives `/clear`.** See [Approvals](#for-this-session-and-clear).
- **Impersonation.** Admins who sign in as another user see that user's entries but cannot show values, answer approvals, switch off **Approval required**, or set up or revoke agent access. Fills requested during impersonation always ask for approval: the card marks them, and they can only be approved once, never for the session. The admin cannot create API keys for that user during impersonation either (`403` "This action requires a signed-in session"), so no key outlives the impersonation. Device-code authorization (`/api/auth/device/authorize`) rejects API keys, and a device session created from an impersonation session is itself an impersonation session with the same limits. Every audit entry from an HTTP request of such a session, of any action, names the admin as `impersonatorId`; entries from WebSocket connections (terminal, SFTP, AI chat) do not carry it yet.
- **Leaving an organization** hides its entries at once, also for MCP sessions that are already running and for a request whose approval card is still waiting.
- **Agent keys open only ephemeral browser sessions.** `browser_open` with `profile: "persistent"` answers `INVALID_PROFILE` for an agent key before a browser starts, so an agent never sees the cookies and logins of your persistent profile.
- **Audit log.** Category Vault: `vault.item_create`, `vault.item_update`, `vault.item_delete`, `vault.reveal`, `vault.use`, `vault.use_denied`, `vault.approve`, `vault.deny`, `vault.approval_timeout`, `vault.agent_key_create`, `vault.agent_key_revoke`, `vault.agent_ip_denied`, `vault.item_unreadable`, `vault.evaluate_locked`, `vault.screenshot_locked`, `vault.input_locked`, `vault.persistent_not_allowed`, `vault.ssh_host_key_pinned`, `vault.ssh_host_key_mismatch`, `vault.ssh_host_key_forgotten`. Entries name the vault entry, agent, server and target, never a value. `vault.use` and `vault.use_denied` also carry the tool and whether it was reading or writing. For `vault_http` they list method, host, path (without query), status and bytes; for `browser_fill_secret` origin and field type; for Git host, repository, `fetch` or `push` and the bytes of the whole operation, written when it ends. For SSH they list target, host, port and user, and for `ssh_exec` the command (cut at 1 KB, with the entry's secrets replaced), exit code, whether it timed out and the bytes of output; for files source, destination and bytes. Never headers, bodies, query strings, file contents or command output.
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

The vault adds seven MCP tools and the Git proxy. The tools appear next to the [browser tools](/browser-tabs#tools) when the vault is on and the account has `vault.use` or is an active member of an organization. `browser_fill_credential` and `browser_fill_secret` additionally need the **Browser Sessions** permission; without it, they behave like unknown tools.

| Tool | Purpose |
| - | - |
| `vault_list` | Lists the entries the caller may use, each with `item` (the identifier for the other tools), `owner` (`personal` or the organization's name), `type`, `description`, `username` or `host`, `origins` or `hosts`, `approvalRequired` and `usableBy` (the tools that can use this entry: `vault_http`, `git` and `browser_fill_secret` for an API key, the last one only with fill origins or **Allow filling tokens on any page**). API keys also show `readOnly`, `allowHttp`, `git` and `fillOrigins`. SSH entries show `username`, `allowSession` and `targets` (each `ref`, `name`, `host`, `port`, `hostKeyKnown`); `usableBy` lists `ssh_exec`, and `ssh_put` and `ssh_get` for agent keys with a server, and is empty without targets. Never a value, and not the Git username. |
| `browser_fill_credential` | `{ item, passwordRef, usernameRef?, sessionId? }`. Fills username and password of a login entry into the fields `passwordRef` and `usernameRef` from `browser_snapshot`. Answers only that both were filled. |
| `vault_http` | `{ item, method, url, headers?, body? }`. Calls an HTTP API with an API key entry. Returns `HTTP <status>`, a short list of response headers and the body as text. |
| `browser_fill_secret` | `{ item, ref, sessionId? }`. Types the value of an API key or Other entry into the field `ref` from `browser_snapshot`. Answers `Filled the value of <item> into the field.` |
| `ssh_exec` | `{ item, target, command, timeoutSec? }`. Runs a shell command on a target of an SSH entry. `target` is as `vault_list` shows it: `server:<id>` or `host:<host>[:<port>]`. `command` is at most 8 KB; `timeoutSec` is 1 to 600, 60 by default. Returns `exit <code>` (with `(timed out after <n> s)` when the time ran out), then stdout and stderr under `--- stdout ---` and `--- stderr ---`, each cut at 64 KB. |
| `ssh_put` | `{ item, target, localPath, remotePath, overwrite? }`. Copies a file from the agent's server to the target. Returns `Copied <bytes> bytes from <source> to <destination>.` Only for agent keys set up on a server. |
| `ssh_get` | `{ item, target, remotePath, localPath, overwrite? }`. Copies a file from the target to the agent's server. Same result and restriction as `ssh_put`. |
| Git proxy | Not a tool: `GET` and `POST` under `/api/vault/git/<host>/<repository>/` for `info/refs`, `git-upload-pack` and `git-receive-pack`, used by `git` itself after the [Git setup](#git). Everything else is `404`. |

`browser_fill_credential` checks, in this order: the entry is visible and a login; the browser session belongs to the caller and is not paused; no `browser_evaluate` has run in its browser context; the session does not use `via` or the persistent profile; the frame of the password field and all frames above it match an allowed origin; `passwordRef` is a password field and `usernameRef` a text, email or phone field; the approval, if required. After the approval Outpost checks once more, right before typing, because the session was free for other tools while the card waited: the agent key is still valid, the entry is still visible to it with the same type and origins, and the session checks pass again. If the entry disappeared in the meantime, for example because you left its organization, the agent gets `vault.item_unknown`; if its origins changed, `vault.origin_mismatch`. Nothing is typed in either case.

### `vault_http`

Outpost sends the request itself and puts the token into the header named by the entry (`Authorization` with <code v-pre>Bearer {{secret}}</code> by default). Checks, in this order: the entry is an API key; `url` is absolute, has no credentials, is at most 8 KB and uses `https:` (or `http:` if the entry allows it); the host, with a non-default port, is one of the entry's hosts; the method is `GET`, `HEAD`, `POST`, `PUT`, `PATCH` or `DELETE`, and `GET` or `HEAD` only for read-only entries; the headers; the body; then the approval, which is for reading or writing.

- **Headers:** at most 30, together at most 8 KB, single-line values. Outpost refuses the entry's own header, `Authorization`, `Cookie`, `Host`, `Content-Length`, `Transfer-Encoding`, `Connection`, everything starting with `Proxy-`, and `Range`, `If-Range`, `X-HTTP-Method-Override`, `X-Method-Override` and `X-HTTP-Method` (`vault.header_not_allowed`). Ranges and method overrides would let a service return only a fragment of the token or run another method than the one you approved. `Keep-Alive`, `Upgrade`, `Expect`, `TE` and `Trailer` are refused too.
- **Body:** a string of at most 1 MB; not allowed with `GET` or `HEAD`.
- **Time:** 30 seconds for the whole call, not counting the wait for the approval.
- **Redirects:** Outpost follows up to 5 on the same origin (`303` becomes `GET` without a body). A redirect to another origin is not followed; the agent gets it with its `location`, and the token never goes there.
- **Response:** the status, the headers `content-type`, `content-length`, `location`, `link`, `etag`, `last-modified`, `retry-after`, `x-ratelimit-*` and `x-github-request-id` (never `set-cookie`), and the body as UTF-8 text up to 256 KB for text types (`text/*`, JSON, XML, JavaScript, form data). A longer body ends with `[truncated after 262144 bytes]`; Outpost cuts at the end first and removes a trailing piece that could be the start of the token. Other bodies appear as `[binary body, <type>, <bytes> bytes]`. See [Responses](#_7-security-model-and-limits) for what is replaced.
- **Limits:** 60 calls per minute and at most 4 running at the same time per agent key (`vault.rate_limited`, `vault.busy`).
- A network failure answers `vault.http_failed` with the kind (timeout, connection, TLS), without query and without token.

### SSH tools

The three tools share a limit of 30 calls per minute and at most 2 running at the same time per agent key (`vault.rate_limited`, `vault.busy`). Outpost checks, in this order: the entry is visible and an SSH entry; the target belongs to the entry and the account behind the key may still use it (`vault.target_not_allowed`, `vault.target_unavailable`); the arguments; the limits; the engine of the target is connected; for `ssh_put` and `ssh_get`, the file checks on the agent's own server (`vault.not_a_file`, `vault.file_too_large`, `vault.file_exists`, `vault.no_agent_server`, `vault.ssh_failed`); the host key and the approval; only then the secrets are read and the connection is made. See [SSH](#_4a-ssh).

### `browser_fill_secret`

The target must be an `<input>` of type text, password, search, url (or without a type), or a `<textarea>` (`vault.field_not_fillable` otherwise). The field's frame and all frames above it must be on one of the entry's fill origins (`vault.origin_mismatch`). With no fill origins and **Allow filling tokens on any page** off, the answer is `vault.no_fill_origins`; the same holds for an organization's entry without fill origins when the account behind the agent may not reveal its values (`vault.reveal`). The session checks of `browser_fill_credential` apply: a fresh session, no `via`, no persistent profile, no earlier `browser_evaluate`. Filling always counts as writing. After the fill, snapshots show `••••`, `browser_evaluate` stays locked in that browser context, and screenshots are refused while the value is visible in a field that is not a password field. It shares the limit of 20 attempts per minute with `browser_fill_credential`.

With an agent key, the browser tools see only the sessions this key opened and their popups. `browser_list` hides your own tabs and those of other agents, a foreign `sessionId` answers like an unknown one, also for `browser_fill_credential`, `via` is limited to the key's own server (`browser_open` with another server answers `VIA_NOT_ALLOWED`), and `browser_open` opens only ephemeral sessions (`INVALID_PROFILE` for `profile: "persistent"`).

| Error | Meaning and next step |
| - | - |
| `vault.item_unknown` | No such entry, or it does not apply to this server. Call `vault_list`. |
| `vault.wrong_type` | The entry's type does not fit the tool (a login for `browser_fill_credential`, an API key for `vault_http`, an API key or Other entry for `browser_fill_secret`). Call `vault_list` and pick an entry whose `usableBy` lists the tool. |
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
| `vault.rate_limited` | Too many calls within a minute: 20 attempts of `browser_fill_credential` and `browser_fill_secret` together, 60 calls of `vault_http`, 30 Git operations per Git key. Refused and invalid calls count too. Wait a minute and try again. The audit log gets one row for this per minute. |
| `vault.approval_stale` | "The entry changed while the approval was open; nothing was done. Call again so the user approves the entry as it is now." |
| `vault.http_not_allowed` | "This entry only allows https." |
| `vault.bad_url` | "url must be an absolute http(s) URL without credentials, at most 8 KB." |
| `vault.host_not_allowed` | "This host is not one of the entry's hosts (vault_list shows them)." |
| `vault.bad_method` | "method must be GET, HEAD, POST, PUT, PATCH or DELETE." |
| `vault.read_only` | "This entry is read-only: only GET/HEAD and git fetch." |
| `vault.header_not_allowed` | "This header cannot be set; Outpost sets authentication, Host, Cookie, Content-Length, Transfer-Encoding, Connection and Proxy-* itself." For a malformed `headers` object the message names the limits instead. |
| `vault.bad_body` | "body must be a string of at most 1 MB and is not allowed with GET or HEAD." |
| `vault.http_failed` | `The request failed (<kind>); nothing was returned.` The kind is timeout, connection or TLS. |
| `vault.busy` | "Too many calls of this key are running; wait for one to finish." At most 4 at the same time. |
| `vault.field_not_fillable` | "ref must point to a text, password, search or url input, or a textarea." |
| `vault.no_fill_origins` | "This entry may not be filled in the browser; ask the user to add fill origins." |
| `vault.git_not_enabled` | `No vault entry with Git enabled covers <host> on this server.` |
| `vault.git_ambiguous` | `Several vault entries with Git enabled cover <host> on this server (<entries>); ask the user to restrict one.` |
| `vault.git_no_operation` | "This request does not belong to a running git operation; run the git command again." |
| `vault.upstream_refused` | `The token was refused by <host>; ask the user to check the entry.` The Git host answered `401` or `403`. |
| `vault.secret_too_short` | "The token of this entry is shorter than 4 characters; ask the user to replace it in Outpost." Nothing was sent. |
| `vault.no_targets` | "This SSH entry has no targets; ask the user to add a server or host in Outpost." |
| `vault.target_not_allowed` | "This target is not one of the entry's targets (vault_list shows them)." |
| `vault.target_unavailable` | "This server is no longer available to you in Outpost; nothing was done." |
| `vault.bad_command` | "command must be a non-empty string of at most 8 KB, without control or bidi characters." |
| `vault.bad_timeout` | "timeoutSec must be a whole number from 1 to 600." |
| `vault.bad_path` | "Paths must be absolute or start with ~/, at most 4 KB, on one line, without control characters." |
| `vault.not_a_file` | `<path> is not a regular file.` |
| `vault.file_too_large` | `<path> is larger than 100 MB.` |
| `vault.file_exists` | `<path> exists; pass overwrite: true to replace it.` |
| `vault.no_agent_server` | "File transfer needs an agent key set up on a server; this connection has none." |
| `vault.host_key_changed` | `The host key of <target> changed (expected <old>, got <new>); nothing was sent. Ask the user to check the server and forget the old key in Outpost.` No card; the user has to forget the key first. |
| `vault.ssh_failed` | `The SSH connection to <target> failed (<kind>); nothing was done.` The kind is connection, timeout, login refused, engine not connected or SFTP not available. For a refused login the message adds "ask the user to check the entry's user and key". If the command of `ssh_exec` was already sent, it ends with "; the command was sent and may have run in full or in part. Check on the target before running it again." instead; do not repeat it blindly. File errors use the SFTP status, see [Files](#files). |
