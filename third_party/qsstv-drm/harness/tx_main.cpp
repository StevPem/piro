// Test-signal generator: QSSTV's (Dream-derived) HamDRM transmitter, writing a WAV.
// usage: drmtx <file> <name> <ext> <robMode 0=A,1=B,2=E> <bw 0=2.2k,1=2.5k> <interleave 0=long,1=short>
//              <qam 0=4,1=16,2=64> <protection 0=high,1=normal> <callsign> <out.wav> [transportID]
#include "drmtransmitter.h"
#include "drmparams.h"
#include "synthes.h"
#include <QFile>
#include <vector>
#include <cstdio>
#include <cstdlib>
bool stopDRM = false;
unsigned int txTransportID = 0;
bool useHybrid = false;
int numTxFrames = 0;
drmTxParams drmParams;
QList<short unsigned int> fixBlockList;
static std::vector<short> out;
void synthesizer::writeBuffer(quint32 *buf, int n) {
  for (int i = 0; i < n; i++) out.push_back((short)(buf[i] & 0xffff));
}
synthesizer theSynth;
synthesizer *synthesPtr = &theSynth;
static void w32(FILE *f, unsigned v) { fwrite(&v, 4, 1, f); }
static void w16(FILE *f, unsigned short v) { fwrite(&v, 2, 1, f); }
int main(int argc, char **argv) {
  if (argc < 11) { fprintf(stderr, "args\n"); return 1; }
  QFile in(argv[1]); in.open(QIODevice::ReadOnly); QByteArray ba = in.readAll();
  drmTxParams p;
  p.robMode = atoi(argv[4]); p.bandwith = atoi(argv[5]); p.interleaver = atoi(argv[6]);
  p.qam = atoi(argv[7]); p.protection = atoi(argv[8]); p.callsign = argv[9]; p.reedSolomon = 0;
  if (argc > 11) txTransportID = atoi(argv[11]);
  drmTransmitter tx;
  tx.init(&ba, QString(argv[2]), QString(argv[3]), p);
  tx.start(true);
  FILE *f = fopen(argv[10], "wb");
  unsigned n = out.size();
  fwrite("RIFF", 1, 4, f); w32(f, 36 + n * 2); fwrite("WAVEfmt ", 1, 8, f); w32(f, 16); w16(f, 1); w16(f, 1);
  w32(f, 48000); w32(f, 96000); w16(f, 2); w16(f, 16); fwrite("data", 1, 4, f); w32(f, n * 2);
  fwrite(out.data(), 2, n, f); fclose(f);
  fprintf(stderr, "%u samples (%.1f s), %d frames\n", n, n / 48000.0, numTxFrames);
  return 0;
}
