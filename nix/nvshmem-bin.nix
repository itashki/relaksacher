# Runtime companion of the pinned PyTorch wheel, distributed by NVIDIA.
{ pkgs, nccl }:
pkgs.stdenv.mkDerivation {
  pname = "nvshmem-bin";
  version = "3.4.5";
  src = pkgs.fetchurl {
    url = "https://files.pythonhosted.org/packages/3c/35/a9bf80a609e74e3b000fef598933235c908fcefcef9026042b8e6dfde2a9/nvidia_nvshmem_cu13-3.4.5-py3-none-manylinux2014_x86_64.manylinux_2_17_x86_64.whl";
    sha256 = "290f0a2ee94c9f3687a02502f3b9299a9f9fe826e6d0287ee18482e78d495b80";
  };
  dontUnpack = true;
  nativeBuildInputs = [
    pkgs.unzip
    pkgs.autoPatchelfHook
    pkgs.autoAddDriverRunpath
  ];
  buildInputs = [
    pkgs.stdenv.cc.cc.lib
    pkgs.cudaPackages.cuda_cudart
    pkgs.cudaPackages.cuda_nvrtc
    pkgs.rdma-core
    pkgs.ucx
    pkgs.libfabric
    pkgs.openmpi
    nccl
  ];
  autoPatchelfIgnoreMissingDeps = [
    "libcuda.so.1"
    "libnvidia-ml.so.1"
  ];
  installPhase = ''
    unzip -q "$src"
    mkdir -p "$out"
    cp -a nvidia/nvshmem/lib "$out/lib"
  '';
  meta.license = pkgs.lib.licenses.bsd3;
}
