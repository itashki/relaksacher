# Shared shell contract: runtime tools in PATH and speech models in the Nix store.
{ pkgs }:
let
  models = import ./models.nix { inherit (pkgs) fetchurl; };
in
pkgs.mkShell {
  name = "relaksacher";
  WHISPER_MODEL = toString models.whisper;
  SILERO_MODEL = toString models.sileroRu;
  SILERO_MODEL_EN = toString models.sileroEn;
  packages = with pkgs; [
    bun
    ollama-cuda
    (whisper-cpp.override {
      cudaSupport = false;
      rocmSupport = false;
      withSDL = false;
    })
    ffmpeg
    yt-dlp
    deno
    (python3.withPackages (ps: [
      ps.torch
      ps.numpy
    ]))
    nodejs
    git
    curl
    cacert
    pkg-config
    gnumake
    stdenv.cc
  ];

}
