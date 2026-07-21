#include "roi.hpp"

#include <cmath>
#include <iostream>

int main() {
  using convax::subtitle_erasure::PixelRegion;
  using convax::subtitle_erasure::padded_temporal_region;
  using convax::subtitle_erasure::text_detector_scale;
  using convax::subtitle_erasure::temporal_flow_scale;

  int failures = 0;
  const auto require = [&failures](bool condition, const char* message) {
    if (condition) return;
    std::cerr << message << '\n';
    ++failures;
  };

  const PixelRegion bottom_band =
      padded_temporal_region({.x = 48, .y = 520, .width = 1184, .height = 172},
                             1280, 720);
  require(bottom_band.x == 0 && bottom_band.y == 456 &&
              bottom_band.width == 1280 && bottom_band.height == 264,
          "bottom subtitle band did not retain bounded temporal context");

  const PixelRegion centered =
      padded_temporal_region({.x = 200, .y = 180, .width = 400, .height = 120},
                             1280, 720);
  require(centered.x == 136 && centered.y == 116 && centered.width == 528 &&
              centered.height == 248,
          "centered subtitle region was not padded on every side");

  const PixelRegion full_frame =
      padded_temporal_region({.x = 0, .y = 0, .width = 1280, .height = 720},
                             1280, 720);
  require(full_frame.x == 0 && full_frame.y == 0 &&
              full_frame.width == 1280 && full_frame.height == 720,
          "full-frame search region escaped the frame bounds");

  const PixelRegion unpadded =
      padded_temporal_region({.x = 10, .y = 20, .width = 30, .height = 40},
                             100, 100, 0);
  require(unpadded.x == 10 && unpadded.y == 20 && unpadded.width == 30 &&
              unpadded.height == 40,
          "zero temporal context changed the search region");

  require(std::abs(temporal_flow_scale(1280, 264) - 0.5) < 1e-9,
          "wide temporal ROI was not bounded to 640 px for flow");
  require(std::abs(temporal_flow_scale(640, 360) - 1.0) < 1e-9,
          "640 px temporal ROI was unexpectedly rescaled");
  require(std::abs(temporal_flow_scale(320, 180) - 1.0) < 1e-9,
          "small temporal ROI was unexpectedly enlarged");
  require(std::abs(text_detector_scale(1280, 240) - 0.5) < 1e-9,
          "wide detector ROI was not bounded to 640 px");
  require(std::abs(text_detector_scale(480, 120) - 1.0) < 1e-9,
          "small detector ROI was unexpectedly enlarged");

  return failures == 0 ? 0 : 1;
}
