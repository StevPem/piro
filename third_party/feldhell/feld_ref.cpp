// Reference Feld-Hell transmitter for PiRO's tests: fldigi's own transmit
// code (src/feld/feld.cxx: get_font_data, nco, send_symbol, send_null_column,
// tx_char, the preamble/postamble of tx_process, initKeyWaveform), copied
// with fldigi's GUI and sound-card plumbing removed, and its default settings
// (Feld-Hell, font "hell 12", 2 ms pulse shaping, transmit width 1).
// GPL-3, like the fldigi code it comes from.
//
//   g++ -O2 -o feld_ref feld_ref.cpp -I <fldigi>/src/feld
//   feld_ref <toneHz> <text-file> <out.f32> <symbols.txt>
//
// out.f32 is mono float32 at 8 kHz; symbols.txt is one line of 0/1
// (one per half-pixel) for the whole transmission.

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <string>
#include <vector>

struct fntchr { char c; int byte[14]; };
#include "FeldHell-12.cxx"

static const double samplerate = 8000;
static const double TWOPI = 2.0 * M_PI;
static const int MAXLEN = 512;
static double OnShape[MAXLEN], OffShape[MAXLEN];
static int hardkeying = 1;          // progdefaults.HellPulseFast default
static const int HellXmtWidth = 1;   // progdefaults.HellXmtWidth default
static double txphacc = 0, txcounter = 0, tone = 1000;
static const double feldcolumnrate = 17.5;
static const double txpixrate = 14 * feldcolumnrate;
static const double upsampleinc = txpixrate / samplerate;
static int prevsymb = 0;
static std::vector<float> audio;
static std::string syms;

static void initKeyWaveform() {
	for (int i = 0; i < MAXLEN; i++) { OnShape[i] = 1.0; OffShape[i] = 0.0; }
	for (int i = 0; i < 32; i++) {
		switch (hardkeying) {
			case 0: OnShape[i] = 0.5*(1.0 - cos(M_PI * i / 33)); break;
			case 1: if (i < 16) OnShape[i] = 0.5*(1.0 - cos(M_PI * i / 16)); break;
			case 2: if (i < 8) OnShape[i] = 0.5*(1.0 - cos(M_PI * i / 8));
			case 3: default: break;
		}
		OffShape[31 - i] = OnShape[i];
	}
}

static int get_font_data(unsigned char c, int col) {
	int bits = 0, mask, bin, ordbits = 0;
	fntchr *font = feldhell_12;
	if (col > 15 || c < ' ' || c > '~') return -1;
	mask = 1 << (15 - col);
	for (int i = 0; i < 14; i++) ordbits |= font[c-' '].byte[i];
	for (int row = 0; row < 14; row ++) {
		bin = font[c - ' '].byte[13 - row] & mask;
		if (bin != 0) bits |= 1 << row;
	}
	int testval = (1 << (15 - col)) - 1;
	if ((bits == 0) && ((ordbits & testval) == 0)) return -1;
	return bits;
}

static double nco(double freq) {
	double x = sin(txphacc);
	txphacc += 2.0 * M_PI * freq / samplerate;
	if (txphacc > TWOPI) txphacc -= TWOPI;
	return x;
}

static void send_symbol(int currsymb, int nextsymb) {
	int outlen = 0;
	double Amp = 1.0;
	syms.push_back(currsymb ? '1' : '0');
	for (;;) {
		if (prevsymb == 0 && currsymb == 1) Amp = OnShape[outlen];
		else if (currsymb == 1 && nextsymb == 0) Amp = OffShape[outlen];
		else Amp = currsymb;
		audio.push_back((float)(Amp * nco(tone)));
		outlen++;
		txcounter += upsampleinc;
		if (txcounter < 1.0) continue;
		txcounter -= 1.0;
		break;
	}
	prevsymb = currsymb;
}

static void send_null_column() { for (int i = 0; i < 14; i++) send_symbol(0, 0); }

static void tx_char(char c) {
	int column = 0, bits, colbits, currbit, nextbit;
	send_null_column();
	if (c == ' ') { send_null_column(); send_null_column(); send_null_column(); }
	else {
		while ((bits = get_font_data(c, column)) != -1) {
			for (int col = 0; col < HellXmtWidth; col++) {
				colbits = bits;
				for (int i = 0; i < 14; i++) {
					currbit = colbits & 1;
					colbits = colbits >> 1;
					nextbit = colbits & 1;
					send_symbol(currbit, nextbit);
				}
			}
			column++;
		}
	}
	send_null_column();
}

int main(int argc, char **argv) {
	if (argc < 5) { fprintf(stderr, "usage: feld_ref <toneHz> <text-file> <out.f32> <symbols.txt>\n"); return 2; }
	tone = atof(argv[1]);
	std::string text;
	{ FILE *f = fopen(argv[2], "rb"); int c; while ((c = fgetc(f)) != EOF) text.push_back((char)c); fclose(f); }
	initKeyWaveform();
	for (int i = 0; i < 3; i++) tx_char('.');          // PREAMBLE
	for (char c : text) tx_char((c == '\r' || c == '\n') ? ' ' : c);
	for (int i = 0; i < 3; i++) tx_char('.');          // POSTAMBLE
	tx_char(' ');
	FILE *o = fopen(argv[3], "wb"); fwrite(audio.data(), sizeof(float), audio.size(), o); fclose(o);
	FILE *s = fopen(argv[4], "w"); fputs(syms.c_str(), s); fputc('\n', s); fclose(s);
	fprintf(stderr, "%zu samples, %zu half-pixels\n", audio.size(), syms.size());
	return 0;
}
