// Agora wake word runtime: the TFLite Micro audio frontend plus TFLite Micro
// itself, compiled to one WebAssembly module. It is the same C/C++ the ESP32
// desk runs (Esp32Agent/Wake.cpp), so a microWakeWord streaming model sees
// bit-identical features and the same interpreter here as on the board.
//
// Only the numeric pipeline lives here. The detection policy (sliding window,
// cutoff, warm-up, refractory, hold-off, VAD gating) is TypeScript in
// web/src/jarvis/wake/engine.ts, where it can be unit tested.

#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include <new>

#include "tensorflow/lite/experimental/microfrontend/lib/frontend.h"
#include "tensorflow/lite/experimental/microfrontend/lib/frontend_util.h"
#include "tensorflow/lite/micro/micro_allocator.h"
#include "tensorflow/lite/micro/micro_interpreter.h"
#include "tensorflow/lite/micro/micro_mutable_op_resolver.h"
#include "tensorflow/lite/micro/micro_resource_variable.h"
#include "tensorflow/lite/schema/schema_generated.h"

#define WAKE_EXPORT extern "C" __attribute__((used, visibility("default")))

namespace {

// What every microWakeWord model was trained on (ESPHome's
// preprocessor_settings.h); identical to Esp32Agent/Wake.cpp.
constexpr int FEATURES = 40;
constexpr int SAMPLE_RATE = 16000;
constexpr size_t WINDOW_MS = 30;
constexpr size_t STEP_MS = 10;
constexpr float LOWER_HZ = 125.0f;
constexpr float UPPER_HZ = 7500.0f;
constexpr int NOISE_SMOOTHING_BITS = 10;
constexpr float NOISE_EVEN_SMOOTHING = 0.025f;
constexpr float NOISE_ODD_SMOOTHING = 0.06f;
constexpr float NOISE_MIN_SIGNAL = 0.05f;
constexpr float PCAN_STRENGTH = 0.95f;
constexpr float PCAN_OFFSET = 80.0f;
constexpr int PCAN_GAIN_BITS = 21;
constexpr int LOG_SCALE_SHIFT = 6;

constexpr size_t VAR_ARENA_BYTES = 1024;
constexpr int MAX_VARIABLES = 20;
constexpr int OP_COUNT = 20;
constexpr int MAX_MODELS = 4;

struct Model {
  uint8_t *data = nullptr;  // the flatbuffer must outlive the interpreter
  uint8_t *tensorArena = nullptr;
  uint8_t *varArena = nullptr;
  tflite::MicroResourceVariables *variables = nullptr;
  tflite::MicroInterpreter *interpreter = nullptr;
  int stride = 0;
  size_t arenaBytes = 0;
};

FrontendState frontend;
bool frontendReady = false;
tflite::MicroMutableOpResolver<OP_COUNT> resolver;
bool opsReady = false;
Model models[MAX_MODELS];

bool registerOps() {
  // The ops ESPHome registers for microWakeWord streaming models.
  return resolver.AddCallOnce() == kTfLiteOk && resolver.AddVarHandle() == kTfLiteOk &&
         resolver.AddReshape() == kTfLiteOk && resolver.AddReadVariable() == kTfLiteOk &&
         resolver.AddStridedSlice() == kTfLiteOk && resolver.AddConcatenation() == kTfLiteOk &&
         resolver.AddAssignVariable() == kTfLiteOk && resolver.AddConv2D() == kTfLiteOk &&
         resolver.AddMul() == kTfLiteOk && resolver.AddAdd() == kTfLiteOk &&
         resolver.AddMean() == kTfLiteOk && resolver.AddFullyConnected() == kTfLiteOk &&
         resolver.AddLogistic() == kTfLiteOk && resolver.AddQuantize() == kTfLiteOk &&
         resolver.AddDepthwiseConv2D() == kTfLiteOk && resolver.AddAveragePool2D() == kTfLiteOk &&
         resolver.AddMaxPool2D() == kTfLiteOk && resolver.AddPad() == kTfLiteOk &&
         resolver.AddPack() == kTfLiteOk && resolver.AddSplitV() == kTfLiteOk;
}

void releaseModel(Model &m) {
  delete m.interpreter;
  free(m.tensorArena);
  free(m.varArena);
  free(m.data);
  m = Model();
}

uint8_t *alignedAlloc(size_t bytes) {
  void *p = nullptr;
  if (posix_memalign(&p, 16, bytes) != 0) return nullptr;
  memset(p, 0, bytes);
  return static_cast<uint8_t *>(p);
}

bool resetVariables(Model &m) {
  tflite::MicroAllocator *allocator = tflite::MicroAllocator::Create(m.varArena, VAR_ARENA_BYTES);
  m.variables = allocator ? tflite::MicroResourceVariables::Create(allocator, MAX_VARIABLES) : nullptr;
  return m.variables != nullptr;
}

// The frontend's log-mel values run 0..~670. Training divided them by 25.6
// (range ~0-26), and quantisation mapped 0..26 onto -128..127, so
// q = v * 256 / (25.6 * 26) - 128, in integers with rounding (Wake.cpp).
int8_t quantize(uint16_t value) {
  int32_t q = (static_cast<int32_t>(value) * 256 + 333) / 666 - 128;
  return static_cast<int8_t>(q < -128 ? -128 : (q > 127 ? 127 : q));
}

}  // namespace

// Starts (or restarts) the frontend. 1 on success.
WAKE_EXPORT int wake_frontend_init() {
  if (frontendReady) {
    FrontendFreeStateContents(&frontend);
    frontendReady = false;
  }
  FrontendConfig config;
  FrontendFillConfigWithDefaults(&config);
  config.window.size_ms = WINDOW_MS;
  config.window.step_size_ms = STEP_MS;
  config.filterbank.num_channels = FEATURES;
  config.filterbank.lower_band_limit = LOWER_HZ;
  config.filterbank.upper_band_limit = UPPER_HZ;
  config.noise_reduction.smoothing_bits = NOISE_SMOOTHING_BITS;
  config.noise_reduction.even_smoothing = NOISE_EVEN_SMOOTHING;
  config.noise_reduction.odd_smoothing = NOISE_ODD_SMOOTHING;
  config.noise_reduction.min_signal_remaining = NOISE_MIN_SIGNAL;
  config.pcan_gain_control.enable_pcan = 1;
  config.pcan_gain_control.strength = PCAN_STRENGTH;
  config.pcan_gain_control.offset = PCAN_OFFSET;
  config.pcan_gain_control.gain_bits = PCAN_GAIN_BITS;
  config.log_scale.enable_log = 1;
  config.log_scale.scale_shift = LOG_SCALE_SHIFT;
  frontendReady = FrontendPopulateState(&config, &frontend, SAMPLE_RATE) != 0;
  return frontendReady ? 1 : 0;
}

// Runs `count` 16 kHz samples through the frontend. Every completed 10 ms
// step writes 40 raw values to `rawOut` (may be null) and 40 quantized int8
// features to `quantOut`, up to `maxFrames`. Returns the number of frames.
// Samples past the frame limit are still consumed so the frontend never
// falls behind; callers size the buffers for count / 160 + 1 frames.
WAKE_EXPORT int wake_frontend_process(const int16_t *samples, int count, uint16_t *rawOut, int8_t *quantOut,
                                      int maxFrames) {
  if (!frontendReady) return -1;
  int frames = 0;
  size_t left = static_cast<size_t>(count);
  while (left) {
    size_t used = 0;
    FrontendOutput out = FrontendProcessSamples(&frontend, samples, left, &used);
    if (!used) break;
    samples += used;
    left -= used;
    if (!out.size) continue;
    if (frames < maxFrames) {
      for (int i = 0; i < FEATURES; i++) {
        uint16_t v = i < static_cast<int>(out.size) ? out.values[i] : 0;
        if (rawOut) rawOut[frames * FEATURES + i] = v;
        quantOut[frames * FEATURES + i] = quantize(v);
      }
    }
    frames++;
  }
  return frames < maxFrames ? frames : maxFrames;
}

// Loads a model into `slot`, copying the flatbuffer. Returns the stride
// (feature frames per invoke, >= 1), or a negative reason:
// -1 bad slot/ops, -2 schema, -3 memory, -4 arena too small, -5 not a
// microWakeWord streaming model ([1,N,40] int8 in, [1,1] uint8 out).
WAKE_EXPORT int wake_model_load(int slot, const uint8_t *data, int size, int arenaBytes) {
  if (slot < 0 || slot >= MAX_MODELS || size <= 0) return -1;
  if (!opsReady) {
    if (!registerOps()) return -1;
    opsReady = true;
  }
  Model &m = models[slot];
  releaseModel(m);
  m.data = alignedAlloc(static_cast<size_t>(size));
  m.varArena = alignedAlloc(VAR_ARENA_BYTES);
  if (!m.data || !m.varArena) {
    releaseModel(m);
    return -3;
  }
  memcpy(m.data, data, static_cast<size_t>(size));
  const tflite::Model *model = tflite::GetModel(m.data);
  if (model->version() != TFLITE_SCHEMA_VERSION) {
    releaseModel(m);
    return -2;
  }
  if (!resetVariables(m)) {
    releaseModel(m);
    return -3;
  }
  // Same growth as the firmware: the manifest's arena, then 1.5x, then 2x.
  const size_t base = (static_cast<size_t>(arenaBytes > 0 ? arenaBytes : 30000) + 15) & ~static_cast<size_t>(15);
  const size_t attempts[] = {base, (base * 3 / 2 + 15) & ~static_cast<size_t>(15),
                             (base * 2 + 15) & ~static_cast<size_t>(15)};
  for (size_t bytes : attempts) {
    m.tensorArena = alignedAlloc(bytes);
    if (!m.tensorArena) break;
    m.interpreter = new (std::nothrow) tflite::MicroInterpreter(model, resolver, m.tensorArena, bytes, m.variables);
    if (m.interpreter && m.interpreter->AllocateTensors() == kTfLiteOk) {
      m.arenaBytes = bytes;
      break;
    }
    delete m.interpreter;
    m.interpreter = nullptr;
    free(m.tensorArena);
    m.tensorArena = nullptr;
    memset(m.varArena, 0, VAR_ARENA_BYTES);
    if (!resetVariables(m)) break;
  }
  if (!m.interpreter) {
    releaseModel(m);
    return -4;
  }
  TfLiteTensor *input = m.interpreter->input(0);
  TfLiteTensor *output = m.interpreter->output(0);
  bool shapeOk = input && output && input->type == kTfLiteInt8 && input->dims->size == 3 &&
                 input->dims->data[0] == 1 && input->dims->data[2] == FEATURES && input->dims->data[1] >= 1 &&
                 output->type == kTfLiteUInt8 && output->dims->size == 2 && output->dims->data[0] == 1 &&
                 output->dims->data[1] == 1;
  if (!shapeOk) {
    releaseModel(m);
    return -5;
  }
  m.stride = input->dims->data[1];
  return m.stride;
}

// The model's int8 input buffer: stride * 40 features, oldest frame first.
WAKE_EXPORT int8_t *wake_model_input(int slot) {
  if (slot < 0 || slot >= MAX_MODELS || !models[slot].interpreter) return nullptr;
  return models[slot].interpreter->input(0)->data.int8;
}

// One inference over the filled input. The uint8 probability 0-255, or -1.
WAKE_EXPORT int wake_model_invoke(int slot) {
  if (slot < 0 || slot >= MAX_MODELS || !models[slot].interpreter) return -1;
  if (models[slot].interpreter->Invoke() != kTfLiteOk) return -1;
  return models[slot].interpreter->output(0)->data.uint8[0];
}

WAKE_EXPORT int wake_model_arena_used(int slot) {
  if (slot < 0 || slot >= MAX_MODELS || !models[slot].interpreter) return -1;
  return static_cast<int>(models[slot].interpreter->arena_used_bytes());
}

// Clears the streaming state (resource variables) so the next invoke starts
// from silence, as after a fresh load.
WAKE_EXPORT int wake_model_reset(int slot) {
  if (slot < 0 || slot >= MAX_MODELS || !models[slot].interpreter) return -1;
  Model &m = models[slot];
  bool ok = m.interpreter->Reset() == kTfLiteOk;
  if (m.variables) ok = m.variables->ResetAll() == kTfLiteOk && ok;
  return ok ? 1 : 0;
}

WAKE_EXPORT void wake_model_free(int slot) {
  if (slot >= 0 && slot < MAX_MODELS) releaseModel(models[slot]);
}

WAKE_EXPORT void *wake_malloc(int bytes) { return malloc(static_cast<size_t>(bytes)); }
WAKE_EXPORT void wake_free(void *p) { free(p); }
