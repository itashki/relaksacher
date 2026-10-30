# Project-local AOT compiler, pinned to canary 1.4.4-canary.1+da867c60b.
# Asset IDs and hashes prevent silently following the moving canary tag.
{ pkgs }:
let
  sources = {
    x86_64-linux = pkgs.fetchurl {
      url = "https://api.github.com/repos/oven-sh/bun/releases/assets/687869747";
      name = "bun-linux-x64.zip";
      curlOptsList = [
        "-H"
        "Accept: application/octet-stream"
      ];
      hash = "sha256-6PJ7JPdBhuh/wPD2A722t5Jk3IahaA2kHiAlo8s+/uA=";
    };
    aarch64-linux = pkgs.fetchurl {
      url = "https://api.github.com/repos/oven-sh/bun/releases/assets/687869647";
      name = "bun-linux-aarch64.zip";
      curlOptsList = [
        "-H"
        "Accept: application/octet-stream"
      ];
      hash = "sha256-puNpJMjG3GNFlmDiekjN1xiafoiOWQJy0CnemNFp0eY=";
    };
  };
in
pkgs.bun.overrideAttrs {
  version = "1.4.4-canary.1";
  src = sources.${pkgs.stdenv.hostPlatform.system};
}
