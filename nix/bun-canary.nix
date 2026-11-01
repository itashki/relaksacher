# Project-local compiler, pinned to canary 1.4.4-canary.1+3f3a9ff87.
# Asset IDs and hashes prevent silently following the moving canary tag.
{ pkgs }:
let
  sources = {
    x86_64-linux = pkgs.fetchurl {
      url = "https://api.github.com/repos/oven-sh/bun/releases/assets/697873851";
      name = "bun-linux-x64.zip";
      curlOptsList = [
        "-H"
        "Accept: application/octet-stream"
      ];
      hash = "sha256-Q+VNHW/ykkRU7lI6QKbYYrpexOWoeWMp5h0i/qZ/JcI=";
    };
    aarch64-linux = pkgs.fetchurl {
      url = "https://api.github.com/repos/oven-sh/bun/releases/assets/697873691";
      name = "bun-linux-aarch64.zip";
      curlOptsList = [
        "-H"
        "Accept: application/octet-stream"
      ];
      hash = "sha256-0F9gulDftzOXS0rNYTWs8KYoysmpZq9jJMGhL5mIM0A=";
    };
  };
in
pkgs.bun.overrideAttrs {
  version = "1.4.4-canary.1";
  src = sources.${pkgs.stdenv.hostPlatform.system};
}
