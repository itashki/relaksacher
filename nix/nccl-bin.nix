# NVIDIA's official prebuilt NCCL; PyTorch links it even for single-GPU ASR.
{ pkgs }:
pkgs.stdenv.mkDerivation {
  pname = "nccl-bin";
  version = "2.32.3";
  src = pkgs.fetchurl {
    url = "https://files.pythonhosted.org/packages/5b/29/6b277e63c92d91f9cb4d1a3a554e148983de39d54baa652bb52c798af78e/nvidia_nccl_cu13-2.32.3-py3-none-manylinux_2_27_x86_64.whl";
    sha256 = "1459723080ac889d73a26edfa3e04383a7928ab31ac8f0ec43b3ea9548b04ff3";
  };
  dontUnpack = true;
  nativeBuildInputs = [
    pkgs.unzip
    pkgs.autoPatchelfHook
    pkgs.autoAddDriverRunpath
  ];
  buildInputs = [ pkgs.stdenv.cc.cc.lib ];
  autoPatchelfIgnoreMissingDeps = [
    "libcuda.so.1"
    "libnvidia-ml.so.1"
  ];
  installPhase = ''
    unzip -q "$src"
    mkdir -p "$out/lib"
    cp -a nvidia/nccl/lib/*.so* "$out/lib/"
  '';
  meta.license = pkgs.lib.licenses.bsd3;
}
