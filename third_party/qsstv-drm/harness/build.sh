#!/bin/sh
# Builds QSSTV's own HamDRM transmitter and receiver as two small command-line
# programs, for making test signals and checking PiRO's JavaScript receiver
# against the original. Nothing here is part of PiRO itself.
#
#   sudo apt install g++ pkg-config qtbase5-dev libfftw3-dev git python3
#   sh third_party/qsstv-drm/harness/build.sh /tmp/drm
#
# Then:
#   /tmp/drm/drmtx <file> <name> <ext> <mode 0=A 1=B 2=E> <bandwidth 0=2.3k 1=2.5k>
#                  <interleave 0=long 1=short> <qam 0=4 1=16 2=64> <protection 0=high 1=normal>
#                  <callsign> <out.wav> [transport id]      (48 kHz mono WAV)
#   /tmp/drm/drmrx <in.wav> <out dir>                       (prints each frame; writes the file)
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
OUT=${1:-/tmp/drm}
QSSTV_COMMIT=97156c9fc210a0b317f1dadc29af6ecadba73a05
mkdir -p "$OUT"
cd "$OUT"
[ -d QSSTV ] || git clone -q https://github.com/ON4QZ/QSSTV.git
(cd QSSTV && git checkout -q "$QSSTV_COMMIT")
Q="$OUT/QSSTV/src"
QT="$(pkg-config --cflags Qt5Core)"
QTL="$(pkg-config --libs Qt5Core)"
CXX="g++ -O1 -fPIC -w -DQT_NO_DEBUG"

# transmitter: QSSTV's drmtx (from Dream), writing to a WAV instead of the sound card
mkdir -p txobj
INC="-I$HERE/stubs-tx -I$Q/drmtx -I$Q/drmtx/common -I$Q/drmtx/common/util -I$Q -I$Q/utils $QT"
for f in $(find "$Q/drmtx/common" -name '*.cpp') "$Q/drmtx/drmtransmitter.cpp"; do
  $CXX $INC -c "$f" -o "txobj/$(basename "$f" .cpp).o"
done
$CXX $INC -c "$HERE/tx_main.cpp" -o txobj/tx_main.o
g++ -o drmtx txobj/*.o $QTL -lfftw3

# receiver: QSSTV's drmrx core, fed from a WAV
python3 - "$Q/dsp/filterparam.cpp" > hilbert_coef.inc <<'EOF'
import re, sys
s = open(sys.argv[1]).read()
body = s.split('drmHilbertCoef[DRMHILBERTTAPS]=', 1)[1].split('};', 1)[0]
print('static const double hilbertCoef[153]=' + body.strip() + '};')
EOF
mkdir -p rxobj
INC="-I$HERE/stubs-rx -I$Q/drmrx -I$Q/utils -I$Q -I. $QT"
for f in bits2bytes channeldecode crc16_bytewise crc8_c deinterleaver demodulator drm filter1 filter1c getfoffsint getmode getofdm getofdmsync getsymbolidx lubksb ludcmp mkfacmap mkmscmap msdhardfac msdhardmsc newfft nrutil psdcmean psdmean viterbi_decode; do
  $CXX $INC -c "$Q/drmrx/$f.cpp" -o "rxobj/$f.o"
done
$CXX $INC -c "$HERE/rx_main.cpp" -o rx_main.o
g++ -o drmrx rx_main.o rxobj/*.o $QTL -lfftw3f -lfftw3
echo "built $OUT/drmtx and $OUT/drmrx"
