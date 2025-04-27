{ pkgs, ... }: {
  channel = "stable-23.11";
  packages = [
    pkgs.nodejs_20
    pkgs.gnumake

    # -- Build Toolchain --
    pkgs.python311
    pkgs.python311Packages.setuptools

    # -- Musl Toolchain ONLY --
    pkgs.musl # Provides musl-gcc/g++, static libc.a etc.

    # Build tools
    pkgs.linuxHeaders
    pkgs.binutils
    pkgs.pkg-config
    pkgs.zlib.static
    pkgs.gcc

    pkgs.jq
    pkgs.yq
    pkgs.cmake # Keep if used elsewhere
    pkgs.gdb   # Keep if used elsewhere
    pkgs.sudo
    pkgs.deno  # Keep if used elsewhere
  ];
  env = {
    PROJECT_ROOT = "$PWD";
    PYTHON_KEYRING_BACKEND = "keyring.backends.null.Keyring";
    npm_config_python = "${pkgs.python311}/bin/python3.11";
    # LIBRARY_PATH might still be helpful, keep it for now
    LIBRARY_PATH = "${pkgs.musl}/lib";
    # Remove CC, CXX, LINK env vars, rely on symlinks and binding.gyp
  };
  idx = {
     extensions = [
      "EchoAPI.echoapi-for-vscode"
      "castrogusttavo.min-theme"
      "castrogusttavo.symbols"
      "ms-vscode.cpptools"
      "ms-vscode.cmake-tools"
      "dbaeumer.vscode-eslint"
      "naumovs.color-highlight"
    ];
    workspace = {
      onCreate = {
        # Use 'npm install' here, 'npm ci' might fail if lock file is bad/missing
        npm-install = "npm install --no-audit --prefer-offline --no-progress --timing";
      };
    };
  };
}