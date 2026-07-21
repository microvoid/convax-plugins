#pragma once

#include <cstddef>
#include <cstdint>
#include <iosfwd>
#include <string>

namespace convax::subtitle_erasure {

inline constexpr int kProtocolVersion = 1;
inline constexpr std::size_t kMaxRequestBytes = 64U * 1024U;

struct PixelRegion {
  int x = 0;
  int y = 0;
  int width = 0;
  int height = 0;
};

struct EraseOptions {
  double detection_fps = 2.0;
  double detector_threshold = 0.20;
  double box_threshold = 0.40;
  int mask_dilation_pixels = 4;
  int max_lama_patch = 512;
  int max_tracking_gap_samples = 2;
};

struct EraseRequest {
  std::int64_t duration_ms = 0;
  int input_height = 0;
  int input_width = 0;
  std::string detector_model_path;
  std::string inpainting_model_path;
  std::string output_relative_path;
  PixelRegion search_region;
  std::string source_path;
  EraseOptions options;
};

class ProtocolError final {
 public:
  ProtocolError(std::string code, std::string message);

  [[nodiscard]] const std::string& code() const noexcept;
  [[nodiscard]] const std::string& message() const noexcept;

 private:
  std::string code_;
  std::string message_;
};

[[nodiscard]] EraseRequest read_request(std::istream& input);

void emit_progress(std::ostream& output,
                   const std::string& stage,
                   double progress);
void emit_result(std::ostream& output, const std::string& output_path);
void emit_error(std::ostream& output, const std::string& message);

}  // namespace convax::subtitle_erasure
