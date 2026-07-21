#include "roi_image.hpp"

#include <iostream>

int main() {
  const cv::Mat original(5, 7, CV_8UC3, cv::Scalar(10, 20, 30));
  const cv::Rect temporal_rect(2, 1, 3, 3);
  const cv::Mat temporal_result(temporal_rect.size(), CV_8UC3,
                                cv::Scalar(90, 100, 110));
  const cv::Mat stitched =
      convax::subtitle_erasure::stitch_temporal_result(
          original, temporal_result, temporal_rect);

  int failures = 0;
  for (int y = 0; y < original.rows; ++y) {
    for (int x = 0; x < original.cols; ++x) {
      const bool inside = temporal_rect.contains(cv::Point(x, y));
      const cv::Vec3b expected =
          inside ? cv::Vec3b(90, 100, 110) : original.at<cv::Vec3b>(y, x);
      if (stitched.at<cv::Vec3b>(y, x) != expected) {
        std::cerr << "temporal stitch modified an unexpected pixel at " << x
                  << ',' << y << '\n';
        ++failures;
      }
    }
  }
  return failures == 0 ? 0 : 1;
}
