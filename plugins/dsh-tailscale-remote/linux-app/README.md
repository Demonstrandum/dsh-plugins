# DSH Remote for Linux

An Electron thin client for an existing DSH server, with automatic loopback
port forwarding. No local DSH installation or submodules are required.

From the repository root:

```sh
nix run .
# Or supply the server on the first launch:
nix run . -- https://host.example.ts.net/dsh/user/
# Short tailnet host name and remote account (uses tailscale status):
nix run . -- remote user
```

Without arguments, the app opens a connection form or the last saved server.
The DSH sidebar shows **DSH Remote** and a blue whale, using the same
`../desktop-branding.js` asset as the Mac wrapper. This identifies the app,
not connection health. Branding is reapplied on navigation/reload and is
restricted to DSH pages; preview pages keep their own appearance.
**File → Change server…** opens the form again. Use the server's full HTTPS
mount URL with a trailing slash. The account in `/dsh/user/` is the account
on the remote host, not necessarily your local Linux account.

The flake supports `x86_64-linux` and `aarch64-linux` and supplies Electron,
its runtime libraries, the pinned `ws` dependency, the Tailscale CLI and
`xdg-utils`. A graphical desktop and a connected system Tailscale service
are prerequisites. It does not start a VPN daemon or change NixOS settings.
Flakes must be enabled (`nix-command` and `flakes`).

To install the **DSH Remote** desktop launcher persistently:

```sh
nix profile add .
```

From another machine, replace `.` with `github:taliesinb/dsh-plugins`.
The first run downloads the Nix runtime closure; npm is not needed on the
client machine. Cookies and the saved server live under
`${XDG_CONFIG_HOME:-~/.config}/dsh-remote/`, with a separate browser partition
for each server URL.

## Forwarding

Opening `http://localhost:5173/` from DSH automatically forwards port 5173
from the DSH server. `127.0.0.0/8`, `[::1]` and `*.localhost` work too.
Use `localhost` in links, not the wildcard bind address `0.0.0.0`.
Embedded previews, popup windows, HTTP requests and WebSocket/HMR traffic
keep their original URLs, including when that local port is already busy.

**Forwarded Ports** shows the local-to-remote mappings. Copy a local URL to
use the tunnel in another browser, or close a forward. Listeners bind only
to `127.0.0.1`, expire after an hour without connections, and close on quit.
An external browser uses the substituted local port; a dev server that
hard-codes its original port in HMR should stay inside the app.

The host must already have `dsh-tailscale-remote`'s forwarding endpoint
enabled and admit your Tailscale identity. Its existing admission, reserved
port and process-owner checks remain authoritative. Denials are shown with
the server's error code. A reserved DSH port is not a preview: use the DSH
HTTPS mount URL instead.

The remote renderer has sandboxing and context isolation enabled, no Node
integration and no preload bridge. Only the local connection form has the
single `connect` IPC method, checked against its window and main frame.
External HTTP(S) links open in the system browser. Device permissions are
denied; clipboard writes, fullscreen and loopback access are allowed for
the configured server and loopback previews. TLS verification stays enabled.

## Development

There is no bundler or separate frontend framework. `main.mjs` owns windows,
configuration and menus; `forward.mjs` owns the TCP/WebSocket byte streams
and a loopback-only HTTP proxy. Chromium bypasses that proxy for non-local
destinations. `ws` supplies WebSocket framing and a backpressured Node stream.
The host protocol stays in the existing `../forward.mjs`.

```sh
# From the repository root: package + Node integration test + Electron smoke.
nix flake check

# Faster tunnel-only iteration, from this directory:
npm ci
npm test
```

The Electron test checks the shared whale colour and label after reload,
keeps the embedded preview unbranded, opens the real connection form, rejects an insecure remote
URL, connects to an isolated fixture, and checks an embedded preview and
hard-coded HMR with an occupied local port. Nix runs it under Xvfb with
`--no-sandbox` because nested Chromium namespaces are unavailable in the
build sandbox. The installed app never passes that flag. The same smoke test
can run with `electron tests/electron-smoke.mjs` in a desktop session, with
the Chromium sandbox enabled.

System setup and troubleshooting: [recipe](../../../recipes/nixos-thin-client.md).
