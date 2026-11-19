# Shared Python with prebuilt CUDA Torch (Blackwell-capable) for GigaAM and SmolVLM2.
{ pkgs }:
let
  nccl = import ./nccl-bin.nix { inherit pkgs; };
  nvshmem = import ./nvshmem-bin.nix { inherit pkgs nccl; };
  python =
    if !pkgs.stdenv.hostPlatform.isx86_64 then
      pkgs.python313
    else
      pkgs.python313.override {
        packageOverrides = final: prev: {
          torch = final.torch-bin;
          torch-bin = prev.torch-bin.overridePythonAttrs (old: {
            version = "2.11.0";
            src = pkgs.fetchurl {
              name = "torch-2.11.0+cu130-cp313-cp313-linux_x86_64.whl";
              url = "https://download.pytorch.org/whl/cu130/torch-2.11.0%2Bcu130-cp313-cp313-manylinux_2_28_x86_64.whl";
              sha256 = "0rk3b05vp3kndml4nyb44fbl5yq01g5nn1bnqwkij891dyvn2i2m";
            };
            pythonRelaxDeps = true;
            buildInputs = map (
              dependency:
              if (dependency.pname or "") == "nccl" then
                nccl
              else if (dependency.pname or "") == "libnvshmem" then
                nvshmem
              else
                dependency
            ) old.buildInputs;
          });
          torchaudio = final.torchaudio-bin;
        };
      };
in
python
