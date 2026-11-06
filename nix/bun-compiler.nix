# Project-local compiler, pinned to stable Bun 1.4.4.
# Stable release URLs and hashes survive replacement of the moving canary release.
{ pkgs }:
let
  sources = {
    x86_64-linux = pkgs.fetchurl {
      url = "https://github.com/oven-sh/bun/releases/download/bun-v1.4.4/bun-linux-x64.zip";
      name = "bun-linux-x64.zip";
      hash = "sha256-v4zL+ysLgBWeD5ptFcVTF63YB3U028YTCj7bUvzLOVw=";
    };
    aarch64-linux = pkgs.fetchurl {
      url = "https://github.com/oven-sh/bun/releases/download/bun-v1.4.4/bun-linux-aarch64.zip";
      name = "bun-linux-aarch64.zip";
      hash = "sha256-uqa7NvUdblhWHgK76oJQOKnfRU9nPW13bou/hvjHhQ4=";
    };
  };
in
pkgs.bun.overrideAttrs {
  version = "1.4.4";
  src = sources.${pkgs.stdenv.hostPlatform.system};
}
