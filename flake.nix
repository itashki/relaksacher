{
  description = "Runtime and development environment for Relaksacher";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { nixpkgs, ... }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
      ];
      forEachSystem = nixpkgs.lib.genAttrs systems;
    in
    {
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
