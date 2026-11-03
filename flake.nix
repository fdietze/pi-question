{
  description = "pi-question — development toolchain for the pi extension";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = {
    nixpkgs,
    flake-utils,
    ...
  }:
    flake-utils.lib.eachDefaultSystem (system: let
      pkgs = nixpkgs.legacyPackages.${system};
    in {
      # KISS: Nix owns tools; npm owns only the versioned TypeScript declarations.
      devShells.default = pkgs.mkShell {
        packages = [
          pkgs.nodejs_24
          pkgs.typescript-go
          pkgs.oxlint
        ];
        # Map is not the territory: node_modules can drift from package-lock.json
        # (e.g. after a lockfile bump), which shows up as bogus type errors. Entering
        # the shell reinstalls whenever the lockfile hash differs from the one that
        # produced node_modules. A failed install leaves no stamp, so the next entry retries.
        shellHook = ''
          if [ -f package-lock.json ]; then
            lock_hash=$(sha256sum package-lock.json | cut -d' ' -f1)
            if [ "$lock_hash" != "$(cat node_modules/.package-lock.sha256 2>/dev/null)" ]; then
              npm ci && echo "$lock_hash" > node_modules/.package-lock.sha256 \
                || echo "pi-question: npm ci failed; node_modules is out of sync" >&2
            fi
          fi
        '';
      };
    });
}
