#!/bin/sh
# Builds src/audio/xara/xara.wasm: Xara's VARA HF modem (https://github.com/x0rro/xara,
# MIT) as a WebAssembly library, with the wrapper in third_party/xara/wasm/.
#
#   third_party/xara/build-wasm.sh [WORKDIR]
#
# Needs Rust (1.85 or newer) and git. It uses the wasm32-unknown-unknown target
# if rustup has it; otherwise it builds Rust's standard library for WebAssembly
# from source (rust-src, or Rust's own repository at the compiler's commit),
# which needs no extra download from static.rust-lang.org.
set -eu

XARA_REPO=https://github.com/x0rro/xara.git
XARA_COMMIT=2e96fcd1563c765a0f5731dae9cc9465c4b86ac6   # xara 0.1.1
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
WORK=${1:-$(mktemp -d)}
OUT=$ROOT/src/audio/xara/xara.wasm

echo "Building in $WORK"
if [ ! -d "$WORK/xara/.git" ]; then
  git clone -q "$XARA_REPO" "$WORK/xara"
fi
cd "$WORK/xara"
git checkout -q --force "$XARA_COMMIT"
git clean -qfdx crates

# The patch: xara-host's TCP server, KISS server and writer use Unix sockets,
# so they are left out on WebAssembly (the wrapper doesn't need them).
git apply "$HERE/xara-wasm.patch"
rm -rf crates/xara-wasm
cp -r "$HERE/wasm" crates/xara-wasm
sed -i 's#"crates/xara-testkit"\]#"crates/xara-testkit", "crates/xara-wasm"]#' Cargo.toml

TARGET=wasm32-unknown-unknown
SYSROOT=$(rustc --print sysroot)
if rustup target list --installed 2>/dev/null | grep -qx "$TARGET"; then
  cargo build --release --target "$TARGET" -p xara-wasm
else
  # Build std from source: rust-src if installed, else Rust's library/ at the compiler's commit.
  SRC=$SYSROOT/lib/rustlib/src/rust/library
  if [ ! -f "$SRC/std/Cargo.toml" ]; then
    COMMIT=$(rustc -vV | sed -n 's/^commit-hash: //p')
    echo "No rust-src: fetching Rust's library/ at $COMMIT"
    R=$WORK/rust
    if [ ! -d "$R/.git" ]; then
      git init -q "$R"
      git -C "$R" remote add origin https://github.com/rust-lang/rust.git
      git -C "$R" config core.sparseCheckout true
      echo "library/" > "$R/.git/info/sparse-checkout"
    fi
    git -C "$R" fetch -q --depth 1 --filter=blob:none origin "$COMMIT"
    git -C "$R" checkout -q FETCH_HEAD
    BT=$(git -C "$R" ls-tree HEAD library/backtrace | awk '{print $3}')
    rm -rf "$WORK/backtrace" && git init -q "$WORK/backtrace"
    git -C "$WORK/backtrace" fetch -q --depth 1 https://github.com/rust-lang/backtrace-rs.git "$BT"
    git -C "$WORK/backtrace" checkout -q FETCH_HEAD
    mkdir -p "$SYSROOT/lib/rustlib/src/rust"
    rm -rf "$SRC" && cp -r "$R/library" "$SRC"
    rm -rf "$SRC/backtrace" && mkdir -p "$SRC/backtrace" && cp -r "$WORK/backtrace/." "$SRC/backtrace/"
  fi
  RUSTC_BOOTSTRAP=1 cargo build --release --target "$TARGET" -Z build-std=std,panic_abort -p xara-wasm
fi

mkdir -p "$(dirname "$OUT")"
cp "target/$TARGET/release/xara_wasm.wasm" "$OUT"
ls -l "$OUT"
