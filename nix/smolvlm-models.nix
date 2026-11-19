# Immutable, predownloaded SmolVLM2 weights: runtime never needs network access.
{ pkgs }:
let
  models = import ./models.nix { inherit (pkgs) fetchurl; };
in
pkgs.linkFarm "smolvlm2-500m-video" (
  pkgs.lib.mapAttrsToList (name: path: { inherit name path; }) models.smolvlm2
)
