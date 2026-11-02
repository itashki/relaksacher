# Immutable, predownloaded weights: runtime ASR never needs network access.
{ pkgs }:
let
  models = import ./models.nix { inherit (pkgs) fetchurl; };
in
pkgs.linkFarm "gigaam-v3-models" [
  {
    name = "v3_e2e_rnnt.ckpt";
    path = models.gigaam;
  }
  {
    name = "v3_e2e_rnnt_tokenizer.model";
    path = models.gigaamTokenizer;
  }
]
