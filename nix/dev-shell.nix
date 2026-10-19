# Shared shell contract: runtime tools in PATH.
{ pkgs }:
pkgs.mkShell {
  name = "relaksacher";
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
    (python3.withPackages (ps: [ ps.torch ps.numpy ]))
    nodejs
    git
    curl
    cacert
    pkg-config
    gnumake
    stdenv.cc
  ];

}
