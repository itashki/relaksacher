# NixOS service; credentials stay outside the Nix store.
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.services.relaksacher;
in
{
  options.services.relaksacher = {
    enable = lib.mkEnableOption "Relaksacher bot";
    package = lib.mkOption {
      type = lib.types.package;
      description = "Relaksacher package to run.";
    };
    environmentFile = lib.mkOption {
      type = lib.types.str;
      description = "Absolute path to a secret systemd environment file.";
    };
    sourceDirectory = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      description = "Absolute working checkout to run read-only at service startup. Include installed node_modules; restart after local edits. The checkout and local secrets are not copied into the Nix store.";
    };
    sourceExecutable = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      description = "Executable relative to sourceDirectory, for example dist/relaksacher. Rebuild locally and restart the service to update it.";
    };
    environment = lib.mkOption {
      type = lib.types.attrsOf lib.types.str;
      default = { };
      description = "Non-secret bot settings. Use absolute paths for facts, personality and models.";
    };
    operators = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
      description = "Users allowed to attach via sudo -u relaksacher.";
    };
  };
  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = cfg.sourceExecutable == null || cfg.sourceDirectory != null;
        message = "services.relaksacher.sourceExecutable requires sourceDirectory.";
      }
    ];
    environment.systemPackages = [ cfg.package ];
    users.groups.relaksacher = { };
    users.users.relaksacher = {
      isSystemUser = true;
      group = "relaksacher";
      home = "/var/lib/relaksacher";
    };
    security.sudo.extraRules = lib.mkIf (cfg.operators != [ ]) [
      {
        users = cfg.operators;
        runAs = "relaksacher";
        commands = [
          {
            command = "${cfg.package}/bin/relaksacher tui";
            options = [ "NOPASSWD" ];
          }
        ];
      }
    ];
    systemd.services.relaksacher = {
      description = "Relaksacher bot";
      wantedBy = [ "multi-user.target" ];
      wants = [ "network-online.target" ];
      after = [ "network-online.target" ];
      environment =
        cfg.environment
        // {
          RELAKSACHER_SOCKET = "/run/relaksacher/control.sock";
          MEMORY_DIR = "/var/lib/relaksacher/memory";
          REQUEST_LOG_FILE = "/var/lib/relaksacher/requests.jsonl";
        }
        // lib.optionalAttrs (cfg.sourceDirectory != null) {
          RELAKSACHER_SOURCE_DIRECTORY = "/run/relaksacher/source";
        }
        // lib.optionalAttrs (cfg.sourceExecutable != null) {
          RELAKSACHER_EXECUTABLE = "/run/relaksacher/source/${cfg.sourceExecutable}";
        };
      serviceConfig = {
        ExecStart = "${cfg.package}/bin/relaksacher service";
        EnvironmentFile = cfg.environmentFile;
        User = "relaksacher";
        Group = "relaksacher";
        StateDirectory = "relaksacher";
        RuntimeDirectory = "relaksacher";
        WorkingDirectory =
          if cfg.sourceExecutable != null then "/run/relaksacher/source" else "/var/lib/relaksacher";
        UMask = "0077";
        Restart = "on-failure";
        RestartSec = 5;
        NoNewPrivileges = true;
        PrivateTmp = true;
        BindReadOnlyPaths = lib.optional (
          cfg.sourceDirectory != null
        ) "${cfg.sourceDirectory}:/run/relaksacher/source";
      };
    };
  };
}
