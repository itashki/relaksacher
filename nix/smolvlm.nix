# Resident SmolVLM2 video describer runtime, sharing the GigaAM Torch build.
{ pkgs }:
let
  python = import ./torch-python.nix { inherit pkgs; };
  # transformers 5 loads the SmolVLM2 image/video processors only through
  # torchvision. Its CUDA ops fail to compile against the prebuilt cu130 Torch
  # headers, and preprocessing needs only the CPU ops, so build without nvcc.
  torchvision = python.pkgs.torchvision.overridePythonAttrs (old: {
    nativeBuildInputs = builtins.filter (
      dependency: (dependency.pname or "") != "cuda_nvcc"
    ) old.nativeBuildInputs;
    env = builtins.removeAttrs old.env [
      "TORCH_CUDA_ARCH_LIST"
      "FORCE_CUDA"
    ];
  });
  # accelerate's tests are not needed at runtime.
  accelerate = python.pkgs.accelerate.overridePythonAttrs (_: {
    doCheck = false;
  });
in
python.withPackages (ps: [
  ps.transformers
  ps.pillow
  ps.num2words
  accelerate
  torchvision
])
