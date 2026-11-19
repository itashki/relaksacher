# Resident Russian ASR runtime. Matching prebuilt Torch/torchaudio avoid CUDA compilation.
{ pkgs }:
let
  python = import ./torch-python.nix { inherit pkgs; };
  gigaam = python.pkgs.buildPythonPackage {
    pname = "gigaam";
    version = "0.2.0";
    pyproject = true;
    src = pkgs.fetchFromGitHub {
      owner = "salute-developers";
      repo = "GigaAM";
      rev = "7447938d791c4f3e643386ee22c33777004293a5";
      hash = "sha256-Lo3q8nhMkttgUCWRUv4ChGYcZlcsn/yNEHW020stPNw=";
    };
    build-system = [ python.pkgs.setuptools ];
    # ONNX/export and gated pyannote VAD are unused; the server segments audio locally.
    pythonRemoveDeps = [
      "onnx"
      "onnxruntime"
    ];
    pythonRelaxDeps = true;
    dependencies = with python.pkgs; [
      torch
      torchaudio
      hydra-core
      omegaconf
      numpy
      soundfile
      sentencepiece
      tqdm
    ];
    doCheck = false;
    pythonImportsCheck = [ "gigaam" ];
  };
in
python.withPackages (_: [ gigaam ])
