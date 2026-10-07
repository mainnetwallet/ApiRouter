#!/bin/sh
# Install the `Router` command on Linux, Linux VPS and macOS.
#
#   scripts/install-router.sh                  -> ~/.local/bin/Router (no root)
#   scripts/install-router.sh --prefix DIR     -> DIR/Router
#   scripts/install-router.sh --system         -> /usr/local/bin/Router (needs write access, e.g. sudo)
#   scripts/install-router.sh --uninstall      -> remove the link (combine with --prefix/--system)
#   scripts/install-router.sh --force          -> replace an existing file at the target
#
# The command is a symlink to bin/Router in this checkout; the checkout stays
# the single source of truth. Shell startup files are never edited.
set -eu

self=$0
while [ -h "$self" ]; do
  dir=$(cd -P "$(dirname -- "$self")" >/dev/null 2>&1 && pwd)
  link=$(readlink "$self")
  case $link in /*) self=$link ;; *) self=$dir/$link ;; esac
done
scripts_dir=$(cd -P "$(dirname -- "$self")" && pwd)
root=$(dirname -- "$scripts_dir")
launcher=$root/bin/Router

target_dir=${HOME:?HOME is not set}/.local/bin
uninstall=0
force=0
while [ $# -gt 0 ]; do
  case $1 in
    --system) target_dir=/usr/local/bin ;;
    --prefix) [ $# -ge 2 ] || { echo "--prefix needs a directory" >&2; exit 2; }; target_dir=$2; shift ;;
    --uninstall) uninstall=1 ;;
    --force) force=1 ;;
    -h|--help) sed -n '2,11p' "$self" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done
target=$target_dir/Router

if [ "$uninstall" -eq 1 ]; then
  if [ -h "$target" ]; then rm -- "$target" && echo "Removed $target"
  elif [ -e "$target" ]; then echo "$target is not a symlink created by this installer; left untouched." >&2; exit 1
  else echo "Nothing to remove at $target"; fi
  exit 0
fi

[ -f "$launcher" ] || { echo "Cannot find $launcher" >&2; exit 1; }
[ -x "$launcher" ] || chmod +x "$launcher" 2>/dev/null || { echo "$launcher is not executable and could not be fixed." >&2; exit 1; }

mkdir -p -- "$target_dir" 2>/dev/null || { echo "Cannot create $target_dir. For a system-wide install run this script with sudo." >&2; exit 1; }
if [ -e "$target" ] || [ -h "$target" ]; then
  if [ -h "$target" ] || [ "$force" -eq 1 ]; then rm -f -- "$target"
  else echo "$target already exists and is not a symlink. Re-run with --force to replace it." >&2; exit 1; fi
fi
ln -s -- "$launcher" "$target" || { echo "Cannot write to $target_dir. For a system-wide install run this script with sudo." >&2; exit 1; }
echo "Router command installed: $target -> $launcher"

case ":$PATH:" in
  *":$target_dir:"*) echo "Run it from any directory with: Router" ;;
  *)
    echo
    echo "$target_dir is not on your PATH yet. Add it for this shell with:"
    echo "  export PATH=\"$target_dir:\$PATH\""
    echo "and to keep it, append that line to ~/.profile (bash/sh), ~/.zprofile (zsh on macOS) or your shell's startup file."
    ;;
esac
