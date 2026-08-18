# Outpost

A self-hosted workspace for servers and remote storage. SSH terminals with tmux session
management, and file panes for SFTP and OneDrive side by side, with transfers running
directly between them.

Outpost started as a fork of [Outpost](https://github.com/gnmyt/Nexterm) and has since
gone its own way.

## No promises

This is a personal project. It is public because there is no reason to hide it, not because
it is a product. There is no support, no roadmap and no release schedule. Issues and pull
requests may go unanswered. If you run it, you are on your own.

## What it does beyond the fork point

- OneDrive as a first-class file source next to SFTP: browse, preview, edit, transfer
- Transfers straight between two panes, across hosts and across providers
- tmux session and window management from the interface
- Sign-in with a Microsoft account
- A key bar for terminals on mobile
- Per-tab initial commands, file view modes, manual tab naming, split-view colors

## Running it

Requires Node.js 22 or newer, Yarn, and the FlatBuffers compiler (`flatc`).

```bash
git clone https://github.com/CallMeTechie/outpost.git
cd outpost
yarn install
cd client && yarn install && cd ..
yarn dev
```

There are no published container images yet.

## License

MIT — see [LICENSE](LICENSE).

Outpost is derived from Outpost, Copyright (c) 2024 Mathias Wagner. The original copyright
notice is retained in the license file, as MIT requires.
