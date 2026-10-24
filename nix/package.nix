# Source distribution with offline, integrity-checked npm dependencies.
{
  lib,
  stdenvNoCC,
  bun,
  nodejs,
  importNpmLock,
  makeWrapper,
  ffmpeg,
  yt-dlp,
  deno,
  python3,
  whisper-cpp,
}:
stdenvNoCC.mkDerivation {
  pname = "relaksacher";
  version = "1.0.0";
  src = lib.cleanSourceWith {
    src = ../.;
    filter =
      path: type:
      let
        relative = lib.removePrefix (toString ../. + "/") (toString path);
        root = builtins.head (lib.splitString "/" relative);
      in
      builtins.elem root [
        "index.ts"
        "src"
        "scripts"
        "nix"
        "package.json"
      ];
  };
  nativeBuildInputs = [
    nodejs
    importNpmLock.npmConfigHook
    makeWrapper
  ];
  npmDeps = importNpmLock {
    npmRoot = ../.;
    packageLock = builtins.fromJSON (builtins.readFile ./package-lock.json);
  };
  dontNpmBuild = true;
  npmFlags = [
    "--ignore-scripts"
    "--legacy-peer-deps"
  ];
  postPatch = "cp nix/package-lock.json package-lock.json";
  dontBuild = true;
  installPhase = ''
    mkdir -p $out/lib/relaksacher $out/bin
    cp -r index.ts src scripts package.json node_modules $out/lib/relaksacher/
    makeWrapper ${bun}/bin/bun $out/bin/relaksacher \
      --add-flags "$out/lib/relaksacher/index.ts" \
      --set RELAKSACHER_PACKAGED 1 \
      --set-default RELAKSACHER_SOCKET /run/relaksacher/control.sock \
      --prefix PATH : ${
        lib.makeBinPath [
          ffmpeg
          yt-dlp
          deno
          (python3.withPackages (ps: [
            ps.torch
            ps.numpy
          ]))
          whisper-cpp
        ]
      }
  '';
  meta = {
    description = "Discord and Telegram assistant with an attachable terminal";
    license = lib.licenses.gpl3Plus;
    platforms = lib.platforms.linux;
    mainProgram = "relaksacher";
  };
}
