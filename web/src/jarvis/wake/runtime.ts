/* Thin typed wrapper over runtime/wake.wasm: TFLite Micro + the TFLM audio
   microfrontend, built by tools/wake-wasm/build.sh from the same C/C++ the
   ESP32 desk runs. Standalone wasm (no emscripten JS glue): the only imports
   are three WASI stubs for stderr and a memory-growth hook. Environment
   agnostic, so the worker and the Node tests share it. */

export const FEATURES = 40;
export const SAMPLE_RATE = 16000;
export const STEP_SAMPLES = 160; // 10 ms per feature frame

interface WakeExports {
  memory: WebAssembly.Memory;
  _initialize(): void;
  wake_frontend_init(): number;
  wake_frontend_process(samples: number, count: number, raw: number, quant: number, maxFrames: number): number;
  wake_model_load(slot: number, data: number, size: number, arena: number): number;
  wake_model_input(slot: number): number;
  wake_model_invoke(slot: number): number;
  wake_model_arena_used(slot: number): number;
  wake_model_reset(slot: number): number;
  wake_model_free(slot: number): void;
  wake_malloc(bytes: number): number;
  wake_free(ptr: number): void;
}

export interface FrontendFrames {
  /** Frames produced by this call. */
  frames: number;
  /** frames * 40 raw log-mel values (0..~670), as the firmware's frontend emits. */
  raw: Uint16Array;
  /** frames * 40 int8 features, quantized exactly as Wake.cpp does. */
  quant: Int8Array;
}

export interface WakeModel {
  readonly slot: number;
  /** Feature frames per inference (the model's input [1, stride, 40]). */
  readonly stride: number;
  readonly arenaUsed: number;
  /** Runs one inference over `stride * 40` int8 features; uint8 probability 0-255. */
  invoke(features: Int8Array): number;
  /** Clears the streaming state. */
  reset(): void;
  free(): void;
}

export interface WakeRuntime {
  /** (Re)starts the frontend; its noise estimate begins from scratch. */
  resetFrontend(): void;
  /** Feeds 16 kHz mono samples; returns the feature frames that completed. */
  process(samples: Int16Array): FrontendFrames;
  loadModel(bytes: Uint8Array, arenaBytes?: number): WakeModel;
}

const LOAD_ERRORS: Record<number, string> = {
  [-1]: "no free model slot",
  [-2]: "its TFLite schema version is not supported",
  [-3]: "out of memory",
  [-4]: "its tensor arena did not fit",
  [-5]: "it is not a microWakeWord streaming model ([1,N,40] int8 in, [1,1] uint8 out)",
};

const MAX_MODELS = 4;
const CHUNK_SAMPLES = 4096;

export async function loadWakeRuntime(wasm: BufferSource | WebAssembly.Module): Promise<WakeRuntime> {
  let exports: WakeExports | null = null;
  let stderr = "";
  const mem = () => exports!.memory.buffer;
  const imports = {
    env: { emscripten_notify_memory_growth: () => {} },
    wasi_snapshot_preview1: {
      // TFLM logs through vfprintf(stderr); surface it instead of dropping it.
      fd_write(_fd: number, iovs: number, iovsLen: number, nwritten: number) {
        const view = new DataView(mem());
        let total = 0;
        for (let i = 0; i < iovsLen; i++) {
          const ptr = view.getUint32(iovs + i * 8, true);
          const len = view.getUint32(iovs + i * 8 + 4, true);
          stderr += new TextDecoder().decode(new Uint8Array(mem(), ptr, len));
          total += len;
        }
        view.setUint32(nwritten, total, true);
        let nl: number;
        while ((nl = stderr.indexOf("\n")) >= 0) {
          console.warn("[wake.wasm]", stderr.slice(0, nl));
          stderr = stderr.slice(nl + 1);
        }
        return 0;
      },
      fd_close: () => 0,
      fd_seek: () => 70, // ESPIPE: stderr is not seekable
    },
  };
  const instance =
    wasm instanceof WebAssembly.Module
      ? await WebAssembly.instantiate(wasm, imports)
      : (await WebAssembly.instantiate(wasm, imports)).instance;
  exports = instance.exports as unknown as WakeExports;
  const ex = exports;
  ex._initialize();
  if (!ex.wake_frontend_init()) throw new Error("wake word frontend did not start");

  const samplesPtr = ex.wake_malloc(CHUNK_SAMPLES * 2);
  const maxFrames = Math.floor(CHUNK_SAMPLES / STEP_SAMPLES) + 2;
  const rawPtr = ex.wake_malloc(maxFrames * FEATURES * 2);
  const quantPtr = ex.wake_malloc(maxFrames * FEATURES);
  const usedSlots = new Set<number>();

  return {
    resetFrontend() {
      if (!ex.wake_frontend_init()) throw new Error("wake word frontend did not restart");
    },

    process(samples) {
      const raw: number[] = [];
      const quant: number[] = [];
      let frames = 0;
      for (let at = 0; at < samples.length; at += CHUNK_SAMPLES) {
        const part = samples.subarray(at, at + CHUNK_SAMPLES);
        new Int16Array(mem(), samplesPtr, part.length).set(part);
        const n = ex.wake_frontend_process(samplesPtr, part.length, rawPtr, quantPtr, maxFrames);
        if (n < 0) throw new Error("wake word frontend is not running");
        if (n) {
          raw.push(...new Uint16Array(mem(), rawPtr, n * FEATURES));
          quant.push(...new Int8Array(mem(), quantPtr, n * FEATURES));
          frames += n;
        }
      }
      return { frames, raw: Uint16Array.from(raw), quant: Int8Array.from(quant) };
    },

    loadModel(bytes, arenaBytes = 30000) {
      let slot = 0;
      while (slot < MAX_MODELS && usedSlots.has(slot)) slot++;
      if (slot >= MAX_MODELS) throw new Error(`wake model not loaded: ${LOAD_ERRORS[-1]}`);
      const dataPtr = ex.wake_malloc(bytes.length);
      new Uint8Array(mem(), dataPtr, bytes.length).set(bytes);
      const stride = ex.wake_model_load(slot, dataPtr, bytes.length, arenaBytes);
      ex.wake_free(dataPtr);
      if (stride < 1) throw new Error(`wake model not loaded: ${LOAD_ERRORS[stride] ?? `error ${stride}`}`);
      usedSlots.add(slot);
      const inputPtr = ex.wake_model_input(slot);
      const inputLen = stride * FEATURES;
      return {
        slot,
        stride,
        arenaUsed: ex.wake_model_arena_used(slot),
        invoke(features) {
          if (features.length !== inputLen) throw new Error(`expected ${inputLen} features, got ${features.length}`);
          new Int8Array(mem(), inputPtr, inputLen).set(features);
          return ex.wake_model_invoke(slot);
        },
        reset() {
          ex.wake_model_reset(slot);
        },
        free() {
          ex.wake_model_free(slot);
          usedSlots.delete(slot);
        },
      };
    },
  };
}
