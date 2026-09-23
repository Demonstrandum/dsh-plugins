{
  description = "DSH Remote desktop client with automatic loopback forwarding";
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
    in {
      packages = forAllSystems (system:
        let pkgs = import nixpkgs { inherit system; };
        in {
          default = pkgs.buildNpmPackage {
            pname = "dsh-remote";
            version = "0.1.0";
            src = pkgs.lib.cleanSourceWith {
              src = ./plugins/dsh-tailscale-remote/linux-app;
              filter = path: type: builtins.baseNameOf path != "node_modules";
            };
            npmDepsHash = "sha256-cK5uhvevwl6rseXqjeLIIXA0rdkebaBozM1pR3BNG70=";
            dontNpmBuild = true;
            nativeBuildInputs = [ pkgs.makeWrapper ];
            nativeCheckInputs = [ pkgs.electron pkgs.xvfb-run ];
            doCheck = true;
            checkPhase = ''
              runHook preCheck
              cp ${./plugins/dsh-tailscale-remote/forward.mjs} ../forward.mjs
              cp ${./plugins/dsh-tailscale-remote/dock-app.mjs} ../dock-app.mjs
              npm test
              xvfb-run -a electron --no-sandbox --disable-gpu tests/electron-smoke.mjs
              runHook postCheck
            '';
            installPhase = ''
              runHook preInstall
              mkdir -p $out/share/dsh-remote/linux-app $out/bin
              cp -r *.mjs *.cjs *.html *.js package.json node_modules $out/share/dsh-remote/linux-app/
              cp ${./plugins/dsh-tailscale-remote/dock-app.mjs} $out/share/dsh-remote/dock-app.mjs
              makeWrapper ${pkgs.electron}/bin/electron $out/bin/dsh-remote \
                --add-flags $out/share/dsh-remote/linux-app \
                --prefix PATH : ${pkgs.lib.makeBinPath [ pkgs.tailscale pkgs.xdg-utils ]}
              mkdir -p $out/share/applications $out/share/icons/hicolor/scalable/apps
              cp ${./plugins/dsh-tailscale-remote/dock-app/icon.svg} $out/share/icons/hicolor/scalable/apps/dsh-remote.svg
              cp ${pkgs.makeDesktopItem {
                name = "dsh-remote";
                desktopName = "DSH Remote";
                comment = "Remote DSH with automatic port forwarding";
                exec = "dsh-remote";
                icon = "dsh-remote";
                categories = [ "Development" ];
              }}/share/applications/* $out/share/applications/
              runHook postInstall
            '';
            meta = {
              description = "DSH desktop thin client with automatic port forwarding";
              mainProgram = "dsh-remote";
              platforms = systems;
            };
          };
        });
      checks = forAllSystems (system: { desktop = self.packages.${system}.default; });
    };
}
