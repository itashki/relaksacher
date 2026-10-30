{
  description = "Runtime and development environment for Relaksacher";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs, ... }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
      ];
      forEachSystem = nixpkgs.lib.genAttrs systems;
    in
    {
      packages = forEachSystem (system: {
        bun-canary = import ./nix/bun-canary.nix { pkgs = nixpkgs.legacyPackages.${system}; };
        default = nixpkgs.legacyPackages.${system}.callPackage ./nix/package.nix { };
      });
      nixosModules.default = { pkgs, ... }: {
        imports = [ ./nix/module.nix ];
        services.relaksacher.package =
          nixpkgs.lib.mkDefault
            self.packages.${pkgs.stdenv.hostPlatform.system}.default;
      };
      devShells = forEachSystem (system: {
        default = import ./nix/dev-shell.nix {
          pkgs = import nixpkgs {
            inherit system;
            config.allowUnfree = true; # CUDA runtime dependencies.
          };
        };
      });
      formatter = forEachSystem (system: nixpkgs.legacyPackages.${system}.nixfmt);
    };
}
