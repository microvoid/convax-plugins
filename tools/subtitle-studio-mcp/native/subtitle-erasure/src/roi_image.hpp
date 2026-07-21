#pragma once

#include <cstdint>

#include <opencv2/core.hpp>

namespace convax::subtitle_erasure {

[[nodiscard]] inline cv::Mat stitch_temporal_result(
    const cv::Mat& original,
    const cv::Mat& temporal_result,
    const cv::Rect& temporal_rect) {
  CV_Assert(temporal_result.size() == temporal_rect.size());
  CV_Assert(temporal_result.type() == original.type());
  CV_Assert(temporal_rect.x >= 0 && temporal_rect.y >= 0 &&
            static_cast<std::int64_t>(temporal_rect.x) +
                    temporal_rect.width <=
                original.cols &&
            static_cast<std::int64_t>(temporal_rect.y) +
                    temporal_rect.height <=
                original.rows);
  cv::Mat result = original.clone();
  temporal_result.copyTo(result(temporal_rect));
  return result;
}

}  // namespace convax::subtitle_erasure
