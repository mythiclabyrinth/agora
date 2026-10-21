// The ESP32 build links the vendored frontend against the esp32 core's
// prebuilt FIXED_POINT=16 kissfft in namespace kiss_fft_fixed16 (see
// Esp32Agent/src/microfrontend/README). On the host we compile the same
// kissfft (TFLM's pinned copy) into that namespace.
#include <cstdint>

#include "kiss_fft_common.h"

#define FIXED_POINT 16
namespace kiss_fft_fixed16 {
#include "kiss_fft.c"
#include "tools/kiss_fftr.c"
}  // namespace kiss_fft_fixed16
#undef FIXED_POINT
