# Shared shell contract: runtime tools in PATH and speech models in the Nix store.
{ pkgs }:
let
  bunCompiler = import ./bun-compiler.nix { inherit pkgs; };
  models = import ./models.nix { inherit (pkgs) fetchurl; };
  # The shell's own Python 3.14 packages (yt-dlp, torch) arrive through
  # PYTHONPATH and would shadow the Python 3.13 SmolVLM2 environment.
  smolvlmPython = pkgs.writeShellScript "smolvlm-python" ''
    unset PYTHONPATH NIX_PYTHONPATH
    exec ${import ./smolvlm.nix { inherit pkgs; }}/bin/python3 "$@"
  '';
in
pkgs.mkShell {
  name = "relaksacher";
  WHISPER_MODEL = toString models.whisper;
  TRANSCRIPTION_BACKEND = "gigaam";
  GIGAAM_PYTHON = "${import ./gigaam.nix { inherit pkgs; }}/bin/python3";
  GIGAAM_MODEL_DIR = toString (import ./gigaam-models.nix { inherit pkgs; });
  SMOLVLM_PYTHON = toString smolvlmPython;
  SMOLVLM_MODEL_DIR = toString (import ./smolvlm-models.nix { inherit pkgs; });
  SILERO_MODEL = toString models.sileroRu;
  SILERO_MODEL_EN = toString models.sileroEn;
  packages = with pkgs; [
    bunCompiler
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
