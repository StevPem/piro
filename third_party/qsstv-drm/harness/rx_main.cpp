// Reference decoder: QSSTV's HamDRM receiver core (drmrx), fed from a WAV file.
// usage: drmrx <in.wav> <outdir>   (prints a log line per event)
#include "drm.h"
#include "drmproto.h"
#include "demodulator.h"
#include "sourcedecoder.h"
#include <QFile>
#include <QString>
#include <cstdio>
#include <cstring>
#include <cmath>
#include <vector>
#include <map>
#include <string>
#include "hilbert_coef.inc"
static std::string outdir;
extern int msc_mode_new, interleaver_depth_new, spectrum_occupancy_new;
extern bool callsignValid;
extern double channel_decoded_data_buffer[];
extern int channel_decoded_data_buffer_data_valid, length_decoded_data, audio_data_flag;
void bits2bytes(double *, int, unsigned char *);
void crc16_bytewise(double *, unsigned char *, long);
static int frameNo = 0;
// --- minimal MOT assembly, following QSSTV's sourcedecoder.cpp ---
struct Seg { std::vector<unsigned char> d; bool ok = false; };
struct TB { std::string name; bool header = false; int total = 0; int segSize = 0; bool last = false; std::map<int, Seg> segs; bool done = false; };
static std::map<int, TB> tbs;
static std::vector<unsigned char> holding; static int lastCI = -1;
static void packet(std::vector<unsigned char> ba) {
  unsigned char h = ba[0];
  bool ext = h & 0x80, crc = h & 0x40, sess = h & 0x20, user = h & 0x10; int type = h & 7;
  if (crc) { double cs; crc16_bytewise(&cs, ba.data(), ba.size()); if (fabs(cs) > 1e-9) { printf("frame %d: MOT group CRC bad\n", frameNo); return; } ba.resize(ba.size() - 2); }
  size_t p = 2; if (ext) p += 2;
  int segNo = 0; bool lastSeg = false;
  if (sess) { segNo = (ba[p] & 0x7f) * 256 + ba[p + 1]; lastSeg = ba[p] & 0x80; p += 2; }
  int tid = 0xffff;
  if (user) { int uaf = ba[p]; p++; int li = uaf & 0xf; if ((uaf & 0x10) && li >= 2) tid = ba[p] * 256 + ba[p + 1]; p += li; }
  int segSize = (ba[p] & 0x1f) * 256 + ba[p + 1]; p += 2;
  std::vector<unsigned char> data(ba.begin() + p, ba.end());
  TB &tb = tbs[tid];
  if (type == 3) {
    tb.header = true;
    size_t q = 7;
    while (q < data.size()) {
      int pli = data[q] >> 6, pid = data[q] & 0x3f;
      if (pli == 0) q += 1; else if (pli == 1) q += 2; else if (pli == 2) q += 5;
      else { int len; if (data[q + 1] & 0x80) { len = (data[q + 1] & 0x7f) * 256 + data[q + 2]; q += 3; } else { len = data[q + 1] & 0x7f; q += 2; }
        if (pid == 12) tb.name = std::string((char *)&data[q + 1], len - 1); q += len; }
    }
    printf("frame %d: MOT header tid %d name '%s'\n", frameNo, tid, tb.name.c_str());
  } else if (type == 4) {
    if (lastSeg) { tb.total = segNo + 1; tb.last = true; } else tb.segSize = segSize;
    if (tb.total < segNo + 1) tb.total = segNo + 1;
    tb.segs[segNo].d = data; tb.segs[segNo].ok = true;
    int have = 0; for (auto &kv : tb.segs) if (kv.second.ok) have++;
    printf("frame %d: MOT data tid %d seg %d%s (%zu bytes) have %d/%d\n", frameNo, tid, segNo, lastSeg ? " last" : "", data.size(), have, tb.total);
    if (tb.header && tb.last && have == tb.total && !tb.done) {
      tb.done = true;
      std::string fn = outdir + "/" + (tb.name.empty() ? "unnamed" : tb.name);
      FILE *f = fopen(fn.c_str(), "wb");
      for (int i = 0; i < tb.total; i++) fwrite(tb.segs[i].d.data(), 1, tb.segs[i].d.size(), f);
      fclose(f);
      printf("COMPLETE %s\n", fn.c_str());
    }
  }
}
void sourceDecoder::init() {}
bool sourceDecoder::decode() {
  frameNo++;
  if (channel_decoded_data_buffer_data_valid != 1) return false;
  int n = length_decoded_data / 8;
  unsigned char buf[4096];
  bits2bytes(channel_decoded_data_buffer, n * 8, buf);
  double cs; crc16_bytewise(&cs, buf, n);
  if (fabs(cs) > 1e-9) { printf("frame %d: packet CRC bad (SNR %.1f)\n", frameNo, WMERFAC); return false; }
  unsigned char h = buf[0]; bool first = h & 0x80, last = h & 0x40; int ppi = (h & 8) >> 3, ci = h & 7;
  int avail; unsigned char *bp;
  if (ppi) { avail = buf[1]; bp = &buf[2]; } else { avail = n - 3; bp = &buf[1]; }
  if (first) { holding.clear(); lastCI = ci; } else { if (lastCI < 0) return false; lastCI = (lastCI + 1) % 8; if (ci != lastCI) { lastCI = -1; return false; } }
  holding.insert(holding.end(), bp, bp + avail);
  printf("frame %d: packet ok %d bytes first %d last %d SNR %.1f mode %d qam %d il %d so %d call %s\n", frameNo, avail, first, last, WMERFAC, robustness_mode, msc_mode_new, interleaver_depth_new, spectrum_occupancy_new, callsignValid ? drmCallsign.toLatin1().data() : "-");
  if (last) packet(holding);
  return true;
}
int main(int argc, char **argv) {
  outdir = argc > 2 ? argv[2] : ".";
  FILE *f = fopen(argv[1], "rb"); fseek(f, 0, SEEK_END); long sz = ftell(f); fseek(f, 44, SEEK_SET);
  std::vector<short> pcm((sz - 44) / 2); fread(pcm.data(), 2, pcm.size(), f); fclose(f);
  unsigned rate = 48000;
  { FILE *g = fopen(argv[1], "rb"); unsigned char hdr[44]; fread(hdr, 1, 44, g); fclose(g); rate = hdr[24] | hdr[25] << 8 | hdr[26] << 16 | hdr[27] << 24; }
  int dec = rate / 12000;
  // decimate: windowed-sinc low-pass at 5 kHz
  std::vector<double> x;
  if (dec == 1) for (short s : pcm) x.push_back(s / 32768.0);
  else {
    int N = 129; std::vector<double> c(N); double sum = 0;
    for (int i = 0; i < N; i++) { double n = i - (N - 1) / 2.0, fc = 5000.0 / rate; double v = n == 0 ? 2 * fc : sin(2 * M_PI * fc * n) / (M_PI * n); v *= 0.54 - 0.46 * cos(2 * M_PI * i / (N - 1)); c[i] = v; sum += v; }
    for (auto &v : c) v /= sum;
    for (size_t k = N; k < pcm.size(); k += dec) { double acc = 0; for (int i = 0; i < N; i++) acc += c[i] * pcm[k - i] / 32768.0; x.push_back(acc); }
  }
  // QSSTV drmHilbertFilter::processIQ: out[2k] = hilbert/gain, out[2k+1] = input delayed by 76
  std::vector<double> hist(153, 0.0);
  static float resamp[2 * 1024];
  srcDecoder = reinterpret_cast<sourceDecoder *>(new char[sizeof(sourceDecoder)]);
  demodulatorPtr = new demodulator;
  demodulatorPtr->init(); initGetmode(DRMBUFSIZE / 4);
  runstate = RUN_STATE_POWER_ON; channel_decoding(); runstate = RUN_STATE_INIT; channel_decoding(); runstate = RUN_STATE_NORMAL;
  for (size_t off = 0; off + 1024 <= x.size(); off += 1024) {
    if (input_samples_buffer_request == 0) demodulatorPtr->demodulate(resamp, 0);
    for (int k = 0; k < 1024; k++) {
      memmove(&hist[1], &hist[0], sizeof(double) * 152); hist[0] = x[off + k];
      double r = 0; for (int i = 0; i < 153; i++) r += hist[i] * hilbertCoef[i];
      resamp[2 * k] = r / 1.569749; resamp[2 * k + 1] = hist[76];
    }
    demodulatorPtr->demodulate(resamp, 1024);
  }
  return 0;
}
