#!/usr/bin/env bash
# install bun with our own little script for provisioning containers/vms. moderately better than `curl | bash`
set -euxo pipefail

DL_HOST=github.com
BUN_REPO=oven-sh/bun
INSTALL_DIR=/usr/local/bin

VERSION="${1:-latest}"
if [[ "$VERSION" = latest ]]; then
    BUN_DL_PREFIX="releases/latest/download"
else
    BUN_DL_PREFIX="releases/download/bun-v$VERSION"
fi

BUN_ARCH="linux-x64$([[ "$(grep -c avx2 /proc/cpuinfo)" -eq 0 ]] && echo "-baseline" || true)"

TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

wget --https-only -nv -P "$TMPDIR" "https://$DL_HOST/$BUN_REPO/$BUN_DL_PREFIX/bun-$BUN_ARCH.zip"
unzip -jo "$TMPDIR/bun-$BUN_ARCH.zip" "bun-*/bun" -d $INSTALL_DIR/

{ set +x; } &> /dev/null
echo -e "\nbun installed to $INSTALL_DIR/bun\nbun on path: $(which bun || echo "not found")\n"
