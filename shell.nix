# Legacy nix-shell uses the same locked nixpkgs revision as nix develop.
{
  pkgs ? import (
    let
      locked = (builtins.fromJSON (builtins.readFile ./flake.lock)).nodes.nixpkgs.locked;
    in
    builtins.fetchTarball {
      url = "https://github.com/NixOS/nixpkgs/archive/${locked.rev}.tar.gz";
      sha256 = locked.narHash;
    }
  ) { config.allowUnfree = true; }, # CUDA runtime dependencies.
}:
import ./nix/dev-shell.nix { inherit pkgs; }
