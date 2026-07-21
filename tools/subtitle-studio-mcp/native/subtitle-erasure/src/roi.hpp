#pragma once

#include "protocol.hpp"

#include <algorithm>
#include <cstdint>

namespace convax::subtitle_erasure {

// Temporal propagation only needs pixels around the host-validated subtitle
// search area. Keep a fixed context band for Farneback's pyramid/window and for
// the largest supported mask dilation, then clamp it to the decoded frame.
[[nodiscard]] inline PixelRegion padded_temporal_region(
    const PixelRegion& search_region,
    int frame_width,
    int frame_height,
    int context_pixels = 64) {
  const int bounded_context = std::max(0, context_pixels);
  const int left = std::max(0, search_region.x - bounded_context);
  const int top = std::max(0, search_region.y - bounded_context);
  const int right = static_cast<int>(std::min<std::int64_t>(
      frame_width, static_cast<std::int64_t>(search_region.x) +
                       search_region.width + bounded_context));
  const int bottom = static_cast<int>(std::min<std::int64_t>(
      frame_height, static_cast<std::int64_t>(search_region.y) +
                        search_region.height + bounded_context));
  return {
      .x = left,
      .y = top,
      .width = right - left,
      .height = bottom - top,
  };
}

[[nodiscard]] inline double temporal_flow_scale(
    int width,
    int height,
    int maximum_dimension = 640) {
  const int largest_dimension = std::max(width, height);
  if (largest_dimension <= 0 || maximum_dimension <= 0) {
    return 1.0;
  }
  return std::min(
      1.0,
      static_cast<double>(maximum_dimension) /
          static_cast<double>(largest_dimension));
}

[[nodiscard]] inline double text_detector_scale(
    int width,
    int height,
    int maximum_dimension = 640) {
  return temporal_flow_scale(width, height, maximum_dimension);
}

}  // namespace convax::subtitle_erasure
