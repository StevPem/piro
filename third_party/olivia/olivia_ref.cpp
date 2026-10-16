// Reference Olivia encoder/decoder built from fldigi's Jalocha MFSK code
// (src/include/jalocha/pj_mfsk.h, GPL-3). Used only to make test fixtures
// for PiRO's JavaScript port; it drives MFSK_Transmitter / MFSK_Receiver the
// same way fldigi's olivia.cxx does.
//
//   olivia_ref tx <tones> <bw> <centreHz> <seed> <text-file> <out.f32> <symbols.txt>
//   olivia_ref rx <tones> <bw> <centreHz> <in.f32>
//
// Audio is mono float32 at 8 kHz. tx writes the start tones, the data and the
// stop tones exactly as fldigi sends them (olivia_start_tones on); symbols.txt
// gets one line per data symbol: "<symbol> <tone>" (tone = Gray-coded index).
// rx prints each decoded byte as a decimal code, then "SNR <x> FOFF <hz>".

#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <cmath>
#include <vector>
#include <string>

// Deterministic replacement for rand(), shared with the JS tests.
static uint32_t g_seed = 1;
static int test_rand() {
	g_seed = g_seed * 1103515245u + 12345u;
	return (int)((g_seed >> 16) & 0x7fff);
}
#define rand() test_rand()
#define private public
#include "pj_mfsk.h"
#undef private
#undef rand

static const int SR = 8000;
static const int SCBLOCK = 512;
static const int TONE_DURATION = SCBLOCK * 16;
static const int SR4 = TONE_DURATION / 4;

static void startStopTones(std::vector<float> &out, double mid, double bw) {
	std::vector<double> amp(SR4, 1.0);
	for (int i = 0; i < SR4 / 8; i++)
		amp[i] = amp[SR4 - 1 - i] = 0.5 * (1.0 - cos(M_PI * i / (SR4 / 8)));
	std::vector<double> buf(TONE_DURATION, 0.0);
	double fa = mid - bw / 2.0, fb = mid + bw / 2.0, ph;
	ph = 0;
	for (int i = 0; i < SR4; i++) {
		ph += 2.0 * M_PI * fa / SR; if (ph > M_PI) ph -= 2.0 * M_PI;
		buf[2 * SR4 + i] = buf[i] = cos(ph) * amp[i];
	}
	ph = 0;
	for (int i = 0; i < SR4; i++) {
		ph += 2.0 * M_PI * fb / SR; if (ph > M_PI) ph -= 2.0 * M_PI;
		buf[3 * SR4 + i] = buf[SR4 + i] = cos(ph) * amp[i];
	}
	for (double v : buf) out.push_back((float)v);
}

static int doTx(int tones, int bw, double centre, uint32_t seed, const char *textPath,
                const char *outPath, const char *symPath) {
	g_seed = seed;
	std::string text;
	{ FILE *f = fopen(textPath, "rb"); if (!f) { perror(textPath); return 1; }
	  int c; while ((c = fgetc(f)) != EOF) text.push_back((char)c); fclose(f); }

	MFSK_Transmitter<double> Tx;
	Tx.Default();
	Tx.Tones = tones; Tx.Bandwidth = bw; Tx.SampleRate = SR; Tx.OutputSampleRate = SR;
	double fc_offset = Tx.Bandwidth * (1.0 - 0.5 / Tx.Tones) / 2.0;
	Tx.FirstCarrierMultiplier = (centre - fc_offset) / 500.0;
	Tx.Reverse = 0;
	if (Tx.Preset() < 0) { fprintf(stderr, "preset failed\n"); return 1; }

	std::vector<float> audio;
	FILE *sym = fopen(symPath, "w");
	std::vector<double> buf(Tx.MaxOutputLen);
	size_t next = 0;
	bool stop = false, post = false;

	Tx.Start();
	startStopTones(audio, centre, Tx.Bandwidth);   // tx_process: send_tones() first
	Tx.PutChar(0);                                  // then one NUL
	for (;;) {
		if (stop || Tx.GetReadReady() < Tx.BitsPerSymbol) {
			if (!stop) {
				if (next >= text.size()) { stop = true; }
				else Tx.PutChar((uint8_t)text[next++]);
			}
			if (stop) Tx.Stop();
		}
		size_t p = Tx.SymbolPtr;
		int len = Tx.Output(buf.data());
		if (Tx.SymbolPtr != p) {
			uint8_t s = Tx.Encoder.OutputBlock[p];
			fprintf(sym, "%d %d\n", s, GrayCode(s));
		}
		for (int i = 0; i < len; i++) audio.push_back((float)buf[i]);
		if (stop && Tx.DoPostambleYet() == 1 && !post) {
			post = true;
			startStopTones(audio, centre, Tx.Bandwidth);
			for (int i = 0; i < SCBLOCK; i++) audio.push_back(0.0f);
		}
		if (!Tx.Running()) break;
	}
	fclose(sym);
	FILE *o = fopen(outPath, "wb");
	fwrite(audio.data(), sizeof(float), audio.size(), o);
	fclose(o);
	fprintf(stderr, "first carrier bin %zu, symbol len %zu, %zu samples\n",
	        Tx.Modulator.FirstCarrier, Tx.Modulator.SymbolLen, audio.size());
	return 0;
}

static int doRx(int tones, int bw, double centre, const char *inPath) {
	MFSK_Receiver<double> Rx;
	Rx.Default();
	Rx.Tones = tones; Rx.Bandwidth = bw; Rx.SyncMargin = 8; Rx.SyncIntegLen = 4;
	Rx.SyncThreshold = 0.0; Rx.SampleRate = SR; Rx.InputSampleRate = SR;
	int fc_offset = Rx.Bandwidth * (1.0 - 0.5 / Rx.Tones) / 2.0;   // int, as olivia.cxx rx_process
	Rx.FirstCarrierMultiplier = (centre - fc_offset) / 500.0;
	Rx.Reverse = 0;
	if (Rx.Preset() < 0) { fprintf(stderr, "preset failed\n"); return 1; }
	FILE *f = fopen(inPath, "rb"); if (!f) { perror(inPath); return 1; }
	std::vector<float> in; float v;
	while (fread(&v, sizeof(float), 1, f) == 1) in.push_back(v);
	fclose(f);
	std::vector<double> chunk(1024);
	double snr = 0, foff = 0;
	for (size_t i = 0; i < in.size(); i += 1024) {
		size_t n = std::min<size_t>(1024, in.size() - i);
		for (size_t k = 0; k < n; k++) chunk[k] = in[i + k];
		Rx.Process(chunk.data(), n);
		uint8_t c;
		while (Rx.GetChar(c) > 0) printf("%d\n", c);
		if (Rx.SignalToNoiseRatio() > 0) { snr = Rx.SignalToNoiseRatio(); foff = Rx.FrequencyOffset(); }
	}
	Rx.Flush();
	uint8_t c;
	while (Rx.GetChar(c) > 0) printf("%d\n", c);
	printf("SNR %.3f FOFF %.3f\n", snr, foff);
	return 0;
}

int main(int argc, char **argv) {
	if (argc >= 9 && !strcmp(argv[1], "tx"))
		return doTx(atoi(argv[2]), atoi(argv[3]), atof(argv[4]), (uint32_t)strtoul(argv[5], 0, 10),
		            argv[6], argv[7], argv[8]);
	if (argc >= 6 && !strcmp(argv[1], "rx"))
		return doRx(atoi(argv[2]), atoi(argv[3]), atof(argv[4]), argv[5]);
	fprintf(stderr, "usage: see the comment at the top of olivia_ref.cpp\n");
	return 2;
}
