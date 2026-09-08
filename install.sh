#!/bin/sh
# Hearth installer. Installs from the npm registry by default; builds from
# a source checkout when run inside one.
#
# From the registry:
#   ./install.sh
#   HEARTH_PKG=@sunshinelife83/hearth@1.0.0 ./install.sh   # pin a version
#
# From a checkout (this directory):
#   ./install.sh
#
# From a packed tarball:
#   HEARTH_PKG=/path/to/sunshinelife83-hearth-1.0.0.tgz ./install.sh
set -eu

PKG="${HEARTH_PKG:-}"

need_node() {
  if ! command -v node >/dev/null 2>&1; then
    echo "error: node is required (22.19+). Install it from https://nodejs.org, then rerun." >&2
    exit 1
  fi
  major="$(node -p 'process.versions.node.split(".")[0]')"
  if [ "$major" -lt 22 ]; then
    echo "error: node 22.19+ is required (found $(node -v))." >&2
    exit 1
  fi
}

is_checkout() {
  [ -f ./package.json ] && [ -f ./src/cli.ts ] && [ -d ./src/dashboard ] \
    && grep -q '"@sunshinelife83/hearth"' ./package.json 2>/dev/null
}

install_from_checkout() {
  echo "Source checkout detected. Packing (this runs the build) ..."
  rm -f ./sunshinelife83-hearth-*.tgz
  if command -v pnpm >/dev/null 2>&1; then
    pnpm install --frozen-lockfile >/dev/null 2>&1 || pnpm install
    pnpm pack >/dev/null 2>&1 || pnpm pack
  else
    npm install --no-audit --no-fund >/dev/null 2>&1 || npm install --no-audit --no-fund
    npm pack >/dev/null 2>&1 || npm pack
  fi
  TARBALL="$(ls -t ./sunshinelife83-hearth-*.tgz 2>/dev/null | head -n 1)"
  if [ -z "$TARBALL" ]; then
    echo "error: packing produced no tarball." >&2
    exit 1
  fi
  echo "Installing $TARBALL globally ..."
  PKG="$TARBALL"
  install_pkg
}

pnpm_global_usable() {
  command -v pnpm >/dev/null 2>&1 || return 1
  bindir="$(pnpm bin -g 2>/dev/null)" || return 1
  case ":$PATH:" in *":$bindir:"*) return 0 ;; *) return 1 ;; esac
}

install_pkg() {
  # Prefer pnpm only when its global bins are actually reachable; otherwise
  # npm (whose global bin is usually on PATH via nvm).
  if pnpm_global_usable; then
    pnpm add -g "$PKG"
  elif command -v npm >/dev/null 2>&1; then
    npm install -g "$PKG"
  else
    echo "error: need pnpm or npm on PATH." >&2
    exit 1
  fi
}

need_node

if [ -z "$PKG" ]; then
  if is_checkout; then
    install_from_checkout
  else
    echo "Installing @sunshinelife83/hearth from the npm registry ..."
    PKG="@sunshinelife83/hearth"
    install_pkg
  fi
else
  echo "Installing $PKG ..."
  install_pkg
fi

if command -v hearth >/dev/null 2>&1; then
  echo "Installed: $(hearth version)"
else
  echo "Installed, but 'hearth' is not on PATH in this shell."
  echo "Add your global bin dir to PATH, e.g.:"
  echo "  export PATH=\"\$(npm prefix -g)/bin:\$PATH\""
fi

if [ -t 0 ]; then
  echo "Running first-time setup ..."
  hearth init
else
  echo "Next: run 'hearth init', then 'hearth serve'. Dashboard: http://127.0.0.1:7176/dashboard"
fi
