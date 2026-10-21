// Cross-check for the wasm frontend: builds the ESP32 desk's *vendored*
// microfrontend (Esp32Agent/src/microfrontend) natively, configured exactly
// as Esp32Agent/Wake.cpp does, and writes the raw uint16 features of a 16 kHz
// mono 16-bit WAV to stdout (40 per 10 ms frame). The web test compares them
// with what wake.wasm produces for the same file. See host/check-features.sh.
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <vector>

#include "frontend.h"
#include "frontend_util.h"

int main(int argc, char **argv) {
  if (argc != 2) {
    fprintf(stderr, "usage: %s file.wav > features.u16\n", argv[0]);
    return 2;
  }
  FILE *f = fopen(argv[1], "rb");
  if (!f) return 1;
  std::vector<uint8_t> bytes;
  uint8_t buf[4096];
  size_t n;
  while ((n = fread(buf, 1, sizeof buf, f)) > 0) bytes.insert(bytes.end(), buf, buf + n);
  fclose(f);
  // Walk RIFF chunks to "data"; the fixtures are PCM16 mono 16 kHz.
  size_t at = 12, dataAt = 0, dataLen = 0;
  while (at + 8 <= bytes.size()) {
    uint32_t size;
    memcpy(&size, &bytes[at + 4], 4);
    if (!memcmp(&bytes[at], "data", 4)) {
      dataAt = at + 8;
      dataLen = size < bytes.size() - dataAt ? size : bytes.size() - dataAt;
      break;
    }
    at += 8 + size + (size & 1);
  }
  if (!dataAt) return 1;
  std::vector<int16_t> pcm(dataLen / 2);
  memcpy(pcm.data(), &bytes[dataAt], pcm.size() * 2);

  // Esp32Agent/Wake.cpp WakeWord::begin(), verbatim values.
  FrontendConfig config;
  FrontendFillConfigWithDefaults(&config);
  config.window.size_ms = 30;
  config.window.step_size_ms = 10;
  config.filterbank.num_channels = 40;
  config.filterbank.lower_band_limit = 125.0f;
  config.filterbank.upper_band_limit = 7500.0f;
  config.noise_reduction.smoothing_bits = 10;
  config.noise_reduction.even_smoothing = 0.025f;
  config.noise_reduction.odd_smoothing = 0.06f;
  config.noise_reduction.min_signal_remaining = 0.05f;
  config.pcan_gain_control.enable_pcan = 1;
  config.pcan_gain_control.strength = 0.95f;
  config.pcan_gain_control.offset = 80.0f;
  config.pcan_gain_control.gain_bits = 21;
  config.log_scale.enable_log = 1;
  config.log_scale.scale_shift = 6;
  FrontendState state;
  if (!FrontendPopulateState(&config, &state, 16000)) return 1;

  // The firmware feeds 10 ms mic blocks; block size does not change the output.
  const int16_t *p = pcm.data();
  size_t left = pcm.size();
  while (left) {
    size_t used = 0;
    FrontendOutput out = FrontendProcessSamples(&state, p, left < 160 ? left : 160, &used);
    if (!used) break;
    p += used;
    left -= used;
    if (out.size) fwrite(out.values, sizeof(uint16_t), out.size, stdout);
  }
  FrontendFreeStateContents(&state);
  return 0;
}
