# NixOS desktop thin client

The root flake builds the Linux Electron client in
`plugins/dsh-tailscale-remote/linux-app/`. It loads a remote DSH and reuses
the existing `api/loopback-forward` WebSocket route; no server changes or
live plugin rebuilds are needed. See the [client README](../plugins/dsh-tailscale-remote/linux-app/README.md)
for app behavior, configuration, limitations and development checks.

## Setup

On a NixOS graphical workstation, enable flakes and Tailscale if necessary
inside `/etc/nixos/configuration.nix`:

```nix
nix.settings.experimental-features = [ "nix-command" "flakes" ];
services.tailscale.enable = true;
```

Apply through your usual NixOS configuration workflow, then connect:

```sh
sudo nixos-rebuild switch
sudo tailscale up
nix run github:taliesinb/dsh-plugins
```

Enter `https://host.example.ts.net/dsh/user/` in the connection form. The
host must admit this workstation's Tailscale identity, and `user` must name
an existing remote instance. The full MagicDNS hostname is required for
the HTTPS certificate. There are no deployment-specific defaults in the
flake or app.

For a checkout, `nix run . -- remote user` resolves the short host through
the packaged Tailscale CLI. `nix run .` subsequently uses the saved server.
`nix profile add .` installs the desktop launcher. The flake supplies the
runtime dependencies; it cannot supply a graphical session or log a system
VPN into the user's tailnet.

## Why this implementation

The Mac bootstrap builds Swift/AppKit/Network.framework code, so it cannot
be run on NixOS. A Chromium `--app` shortcut displays the UI but has no native
TCP forwarding component. The Linux wrapper supplies that component without
porting or rebuilding DSH.

Chromium's fixed proxy configuration uses `*;<-loopback>` as the bypass
list: ordinary destinations go direct, loopback destinations go through
the client's HTTP proxy. The proxy connects to the matching local tunnel;
each accepted TCP connection becomes one authenticated WebSocket to DSH.
The original HTTP Host and WebSocket URL survive even when a local port
collision forces a different listener port. No URL rewrite or HTTP content
rewrite is needed.

### Shared desktop branding

`plugins/dsh-tailscale-remote/desktop-branding.js` is the single browser-side
branding function for both desktop wrappers. It sanitizes the supplied label
and hex colour, sets `__DSH_DOCK__`, and installs the existing sidebar CSS.
The Mac builder copies it into `Contents/Resources/desktop-branding.js`;
Swift reads it and supplies the app's configured name/colour at document
start. Existing installed Mac apps need a deliberate rebuild to pick this
up; none were rebuilt as part of this change.

The Nix package copies the same file beside `dock-app.mjs`. Electron runs it
on `dom-ready` for the configured DSH mount, with `DSH Remote` and `#0090FF`.
It runs again after reload without adding a privileged preload to remote
pages, and skips preview pages. The colour denotes remote app identity,
not live network health. `nix flake check` checks computed sidebar colours,
labels, reload persistence and an unbranded preview. macOS compilation and
resource loading still require a Mac for verification.

When rebasing onto the integrated Mac title bar, preserve its 18% sidebar
wash in the shared branding script under `html[data-platform="darwin"]`.
The Electron smoke test checks that this rule stays inactive on Linux and
applies when the macOS platform attribute is present.

Two traps found while implementing:

- PAC scripts cannot disable Chromium's implicit localhost bypass. Use the
  fixed proxy configuration; the Electron test asserts its actual routing.
- A top-level `await app.whenReady()` in the ESM entry point can stall
  startup: Electron waits for module evaluation before becoming ready.
  Register `app.whenReady().then(...)` instead.

`0.0.0.0` is not covered by Chromium's implicit loopback proxy rule; use
`localhost` in preview links. It can still be the server's bind address.

## Verification

```sh
nix flake check
nix run . -- --help
```

The flake's package build runs the Node integration test against the real
host handler (with fixture process owners), then an Electron/Xvfb test of
the actual setup form, embedded preview, hard-coded WebSocket/HMR, local
port conflict, menu, and absence of Node/IPC in remote content. The Node
test also checks a 3 MiB byte transfer, concurrent requests for one forward,
cookies, refusal codes and cleanup. Neither test touches the live DSH home.
The initial verification was on x86_64 NixOS; aarch64 is declared but needs
its own machine for runtime verification.

| Symptom | Action |
|---|---|
| Short hostname cannot resolve | Connect the system Tailscale service, or supply the full HTTPS URL. |
| HTTP 401/403 at the DSH page | Ask the instance owner to admit your Tailscale identity. |
| `disabled` / `not-operator` when opening a preview | The host's forwarding policy denies this request. |
| `nothing-listening` / `foreign-owner` | Start the preview under the same remote account as DSH. |
| `reserved` | Use the HTTPS DSH mount URL, not its internal port. |
| Local port is occupied | Automatic remapping works inside the app; copy the mapped URL from Forwarded Ports for another browser. |
| No graphical display | Run from a desktop session; `nix run` does not create one. |
| Hardened system disallows unprivileged user namespaces | Chromium needs a working sandbox; configure the workstation's sandbox support instead of adding `--no-sandbox` to the app launcher. |
