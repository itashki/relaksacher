# Shared shell contract: runtime tools in PATH; Piper always resolves to the TTS package.
{ pkgs }:
let
  piper = pkgs.piper-tts.override {
    withTrain = false;
    withHTTP = false;
    withAlignment = false;
    withJapanese = false;
  };
in
pkgs.mkShell {
  name = "relaksacher";
  packages = with pkgs; [
    bun
    ollama-cuda
    piper
    (whisper-cpp.override {
      cudaSupport = false;
      rocmSupport = false;
      withSDL = false;
    })
    ffmpeg
    yt-dlp
    deno
    python3
    nodejs
    git
    curl
    cacert
    pkg-config
    gnumake
    stdenv.cc
  ];

  # Exporting the resolved path also overrides obsolete PIPER_BIN entries in .env.
  shellHook = ''
    export PIPER_BIN="${piper}/bin/piper"
  '';
}
