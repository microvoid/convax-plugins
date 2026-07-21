#include "engine.hpp"

#include "process.hpp"
#include "roi.hpp"
#include "roi_image.hpp"

#include <opencv2/core.hpp>
#include <opencv2/dnn.hpp>
#include <opencv2/geometry.hpp>
#include <opencv2/imgproc.hpp>
#include <opencv2/video/tracking.hpp>
#include <opencv2/videoio.hpp>

#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <filesystem>
#include <functional>
#include <limits>
#include <map>
#include <numeric>
#include <optional>
#include <set>
#include <string>
#include <string_view>
#include <tuple>
#include <unordered_map>
#include <utility>
#include <vector>

namespace convax::subtitle_erasure {
namespace {

namespace fs = std::filesystem;

struct Detection {
  std::vector<cv::Point> polygon;
  cv::Rect2f bounds;
  float score = 0.0F;
  int track_id = -1;
};

struct Keyframe {
  std::int64_t frame_index = 0;
  bool scene_cut = false;
  std::vector<Detection> detections;
};

struct Track {
  int id = -1;
  cv::Rect2f bounds;
  int hits = 0;
  int missed_samples = 0;
  double score_sum = 0.0;
  std::int64_t first_frame = 0;
  std::int64_t last_frame = 0;
  bool active = true;
};

struct DetectionTimeline {
  std::vector<Keyframe> keyframes;
  std::set<int> accepted_track_ids;
  std::int64_t frame_count = 0;
  double fps = 0.0;
  cv::Size frame_size;
  cv::Rect search_rect;
};

struct FlowField {
  cv::Mat consistency;
  cv::Mat map;
};

struct FlowPair {
  FlowField forward;
  FlowField backward;
};

struct WarpedCandidate {
  cv::Mat image;
  cv::Mat valid;
};

using UnitProgressCallback = std::function<void(double)>;

class TemporaryArtifacts final {
 public:
  explicit TemporaryArtifacts(std::vector<fs::path> paths)
      : paths_(std::move(paths)) {}

  TemporaryArtifacts(const TemporaryArtifacts&) = delete;
  TemporaryArtifacts& operator=(const TemporaryArtifacts&) = delete;

  ~TemporaryArtifacts() {
    std::error_code error;
    for (const fs::path& path : paths_) {
      static_cast<void>(fs::remove(path, error));
      error.clear();
    }
  }

 private:
  std::vector<fs::path> paths_;
};

[[noreturn]] void fail(std::string code, std::string message) {
  throw ProtocolError(std::move(code), std::move(message));
}

void check_cancelled(const std::atomic_bool& cancelled) {
  if (cancelled.load(std::memory_order_relaxed)) {
    fail("CANCELLED", "subtitle erasure was cancelled");
  }
}

[[nodiscard]] fs::path require_directory(const fs::path& path,
                                         std::string_view label) {
  std::error_code error;
  const fs::file_status status = fs::symlink_status(path, error);
  if (error || !fs::is_directory(status) || fs::is_symlink(status)) {
    fail("RUNTIME_INVALID", std::string(label) + " is not a safe directory");
  }
  const fs::path canonical = fs::canonical(path, error);
  if (error) {
    fail("RUNTIME_INVALID", std::string(label) + " cannot be resolved");
  }
  return canonical;
}

[[nodiscard]] fs::path require_regular_file(const fs::path& path,
                                            std::string_view label) {
  std::error_code error;
  const fs::file_status status = fs::symlink_status(path, error);
  if (error || !fs::is_regular_file(status) || fs::is_symlink(status)) {
    fail("RUNTIME_INVALID", std::string(label) + " is not a safe regular file");
  }
  const fs::path canonical = fs::canonical(path, error);
  if (error) {
    fail("RUNTIME_INVALID", std::string(label) + " cannot be resolved");
  }
  return canonical;
}

[[nodiscard]] fs::path require_executable_file(const fs::path& path,
                                               std::string_view label) {
  const fs::path canonical = require_regular_file(path, label);
  std::error_code error;
  const fs::perms permissions = fs::status(canonical, error).permissions();
  const fs::perms executable = fs::perms::owner_exec | fs::perms::group_exec |
                               fs::perms::others_exec;
  if (error || (permissions & executable) == fs::perms::none) {
    fail("RUNTIME_INVALID", std::string(label) + " is not executable");
  }
  return canonical;
}

[[nodiscard]] bool is_contained_path(const fs::path& root,
                                     const fs::path& candidate) {
  const auto mismatch = std::mismatch(root.begin(), root.end(), candidate.begin(),
                                      candidate.end());
  return mismatch.first == root.end();
}

[[nodiscard]] cv::Rect pixel_search_rect(const PixelRegion& region,
                                         const cv::Size& frame_size) {
  if (region.x < 0 || region.y < 0 || region.width < 1 || region.height < 1 ||
      static_cast<std::int64_t>(region.x) + region.width > frame_size.width ||
      static_cast<std::int64_t>(region.y) + region.height > frame_size.height) {
    fail("VIDEO_METADATA_MISMATCH",
         "the requested pixel region is outside the decoded video frame");
  }
  return {region.x, region.y, region.width, region.height};
}

[[nodiscard]] float intersection_over_union(const cv::Rect2f& first,
                                            const cv::Rect2f& second) {
  const cv::Rect2f intersection = first & second;
  const float intersection_area = std::max(0.0F, intersection.area());
  const float union_area = std::max(0.0F, first.area()) +
                           std::max(0.0F, second.area()) - intersection_area;
  return union_area > 0.0F ? intersection_area / union_area : 0.0F;
}

[[nodiscard]] double center_distance_ratio(const cv::Rect2f& first,
                                           const cv::Rect2f& second) {
  const cv::Point2f first_center(first.x + first.width * 0.5F,
                                 first.y + first.height * 0.5F);
  const cv::Point2f second_center(second.x + second.width * 0.5F,
                                  second.y + second.height * 0.5F);
  const double distance = cv::norm(first_center - second_center);
  const double scale =
      std::max(1.0, 0.5 * (cv::norm(cv::Point2f(first.width, first.height)) +
                           cv::norm(cv::Point2f(second.width, second.height))));
  return distance / scale;
}

[[nodiscard]] cv::Mat make_scene_signature(const cv::Mat& frame) {
  cv::Mat gray;
  cv::cvtColor(frame, gray, cv::COLOR_BGR2GRAY);
  cv::resize(gray, gray, cv::Size(160, 90), 0.0, 0.0, cv::INTER_AREA);
  const int channels[] = {0};
  const int histogram_size[] = {32};
  const float range[] = {0.0F, 256.0F};
  const float* ranges[] = {range};
  cv::Mat histogram;
  cv::calcHist(&gray, 1, channels, cv::Mat(), histogram, 1, histogram_size,
               ranges, true, false);
  cv::normalize(histogram, histogram, 1.0, 0.0, cv::NORM_L1);
  return histogram;
}

[[nodiscard]] bool is_scene_cut(const cv::Mat& previous_signature,
                                const cv::Mat& current_signature) {
  if (previous_signature.empty()) {
    return false;
  }
  return cv::compareHist(previous_signature, current_signature,
                         cv::HISTCMP_BHATTACHARYYA) > 0.55;
}

class TextDetector final {
 public:
  explicit TextDetector(const fs::path& model_path) {
    try {
      network_ = cv::dnn::readNetFromONNX(model_path.string());
      network_.setPreferableBackend(cv::dnn::DNN_BACKEND_OPENCV);
      network_.setPreferableTarget(cv::dnn::DNN_TARGET_CPU);
    } catch (const cv::Exception&) {
      fail("DETECTOR_LOAD_FAILED", "failed to load the pinned text detector");
    }
    if (network_.empty()) {
      fail("DETECTOR_LOAD_FAILED", "the pinned text detector is empty");
    }
  }

  [[nodiscard]] std::vector<Detection> detect(
      const cv::Mat& frame,
      const cv::Rect& search_rect,
      const EraseOptions& options,
      const std::atomic_bool& cancelled) {
    check_cancelled(cancelled);
    const cv::Mat search_image = frame(search_rect);
    const double scale =
        text_detector_scale(search_image.cols, search_image.rows);
    const int resized_width = std::max(
        32, static_cast<int>(std::ceil(search_image.cols * scale / 32.0)) * 32);
    const int resized_height = std::max(
        32, static_cast<int>(std::ceil(search_image.rows * scale / 32.0)) * 32);

    // PP-OCRv6's pinned inference contract decodes and normalizes BGR. Keep
    // OpenCV's native channel order instead of applying an RGB swap here.
    cv::Mat normalized;
    cv::resize(search_image, normalized,
               cv::Size(resized_width, resized_height), 0.0, 0.0,
               cv::INTER_LINEAR);
    normalized.convertTo(normalized, CV_32FC3, 1.0 / 255.0);
    std::vector<cv::Mat> channels;
    cv::split(normalized, channels);
    constexpr float means[] = {0.485F, 0.456F, 0.406F};
    constexpr float standard_deviations[] = {0.229F, 0.224F, 0.225F};
    for (std::size_t channel = 0; channel < channels.size(); ++channel) {
      channels[channel] =
          (channels[channel] - means[channel]) / standard_deviations[channel];
    }
    cv::merge(channels, normalized);
    const cv::Mat input = cv::dnn::blobFromImage(normalized);

    cv::Mat prediction;
    try {
      network_.setInput(input);
      prediction = network_.forward();
    } catch (const cv::Exception&) {
      fail("DETECTOR_INFERENCE_FAILED", "text detector inference failed");
    }
    check_cancelled(cancelled);
    if (prediction.dims != 4 || prediction.total() == 0U) {
      fail("DETECTOR_OUTPUT_INVALID",
           "text detector returned an unsupported tensor");
    }

    int probability_height = 0;
    int probability_width = 0;
    if (prediction.size[1] == 1) {
      probability_height = prediction.size[2];
      probability_width = prediction.size[3];
    } else if (prediction.size[3] == 1) {
      probability_height = prediction.size[1];
      probability_width = prediction.size[2];
    } else {
      fail("DETECTOR_OUTPUT_INVALID",
           "text detector output must have one probability channel");
    }
    cv::Mat probabilities(probability_height, probability_width, CV_32F,
                          prediction.ptr<float>());
    probabilities = probabilities.clone();

    cv::Mat binary;
    cv::threshold(probabilities, binary, options.detector_threshold, 255.0,
                  cv::THRESH_BINARY);
    binary.convertTo(binary, CV_8U);
    cv::morphologyEx(binary, binary, cv::MORPH_CLOSE,
                     cv::getStructuringElement(cv::MORPH_RECT, cv::Size(3, 3)));

    std::vector<std::vector<cv::Point>> contours;
    cv::findContours(binary, contours, cv::RETR_LIST, cv::CHAIN_APPROX_SIMPLE);
    std::vector<Detection> detections;
    detections.reserve(contours.size());
    for (const std::vector<cv::Point>& contour : contours) {
      if (cv::contourArea(contour) < 12.0) {
        continue;
      }
      cv::Mat contour_mask = cv::Mat::zeros(binary.size(), CV_8U);
      cv::fillPoly(contour_mask,
                   std::vector<std::vector<cv::Point>>{contour}, cv::Scalar(255));
      const float score = static_cast<float>(cv::mean(probabilities, contour_mask)[0]);
      if (score < static_cast<float>(options.box_threshold)) {
        continue;
      }

      const cv::RotatedRect box = cv::minAreaRect(contour);
      if (std::min(box.size.width, box.size.height) < 2.0F) {
        continue;
      }
      // Approximate the pinned DBPostProcess unclip_ratio=1.4 with the
      // equivalent offset distance before mapping the box back to source
      // pixels. Final mask dilation remains a separate outline/shadow guard.
      const double perimeter = cv::arcLength(contour, true);
      if (!std::isfinite(perimeter) || perimeter <= 0.0) {
        continue;
      }
      constexpr double unclip_ratio = 1.4;
      const float unclip_distance = static_cast<float>(
          cv::contourArea(contour) * unclip_ratio / perimeter);
      const cv::RotatedRect unclipped_box(
          box.center,
          cv::Size2f(box.size.width + unclip_distance * 2.0F,
                     box.size.height + unclip_distance * 2.0F),
          box.angle);
      cv::Point2f box_points[4];
      unclipped_box.points(box_points);
      Detection detection;
      detection.score = score;
      detection.polygon.reserve(4U);
      for (const cv::Point2f& point : box_points) {
        const double mapped_x = static_cast<double>(search_rect.x) +
                                static_cast<double>(point.x) *
                                    static_cast<double>(search_rect.width) /
                                    static_cast<double>(probability_width);
        const double mapped_y = static_cast<double>(search_rect.y) +
                                static_cast<double>(point.y) *
                                    static_cast<double>(search_rect.height) /
                                    static_cast<double>(probability_height);
        detection.polygon.emplace_back(
            std::clamp(static_cast<int>(std::lround(mapped_x)), 0, frame.cols - 1),
            std::clamp(static_cast<int>(std::lround(mapped_y)), 0, frame.rows - 1));
      }
      detection.bounds = cv::boundingRect(detection.polygon);
      if (detection.bounds.area() >= 16.0F) {
        detections.push_back(std::move(detection));
      }
    }
    return detections;
  }

 private:
  cv::dnn::Net network_;
};

class TemporalTracker final {
 public:
  explicit TemporalTracker(int max_gap_samples)
      : max_gap_samples_(max_gap_samples) {}

  void assign(std::vector<Detection>& detections,
              std::int64_t frame_index,
              bool scene_cut) {
    if (scene_cut) {
      for (Track& track : tracks_) {
        track.active = false;
      }
    }

    struct MatchCandidate {
      std::size_t track_index = 0;
      std::size_t detection_index = 0;
      double quality = 0.0;
    };
    std::vector<MatchCandidate> candidates;
    for (std::size_t track_index = 0; track_index < tracks_.size();
         ++track_index) {
      if (!tracks_[track_index].active) {
        continue;
      }
      for (std::size_t detection_index = 0;
           detection_index < detections.size(); ++detection_index) {
        const float overlap = intersection_over_union(
            tracks_[track_index].bounds, detections[detection_index].bounds);
        const double center_ratio = center_distance_ratio(
            tracks_[track_index].bounds, detections[detection_index].bounds);
        if (overlap >= 0.15F || center_ratio <= 0.75) {
          candidates.push_back({
              .track_index = track_index,
              .detection_index = detection_index,
              .quality = static_cast<double>(overlap) * 2.0 - center_ratio,
          });
        }
      }
    }
    std::sort(candidates.begin(), candidates.end(),
              [](const MatchCandidate& first, const MatchCandidate& second) {
                return first.quality > second.quality;
              });

    std::set<std::size_t> matched_tracks;
    std::set<std::size_t> matched_detections;
    for (const MatchCandidate& candidate : candidates) {
      if (matched_tracks.contains(candidate.track_index) ||
          matched_detections.contains(candidate.detection_index)) {
        continue;
      }
      Track& track = tracks_[candidate.track_index];
      Detection& detection = detections[candidate.detection_index];
      track.bounds = detection.bounds;
      ++track.hits;
      track.missed_samples = 0;
      track.score_sum += detection.score;
      track.last_frame = frame_index;
      detection.track_id = track.id;
      matched_tracks.insert(candidate.track_index);
      matched_detections.insert(candidate.detection_index);
    }

    for (std::size_t track_index = 0; track_index < tracks_.size();
         ++track_index) {
      Track& track = tracks_[track_index];
      if (!track.active || matched_tracks.contains(track_index)) {
        continue;
      }
      ++track.missed_samples;
      if (track.missed_samples > max_gap_samples_) {
        track.active = false;
      }
    }

    for (std::size_t detection_index = 0;
         detection_index < detections.size(); ++detection_index) {
      if (matched_detections.contains(detection_index)) {
        continue;
      }
      Detection& detection = detections[detection_index];
      detection.track_id = next_track_id_++;
      tracks_.push_back({
          .id = detection.track_id,
          .bounds = detection.bounds,
          .hits = 1,
          .missed_samples = 0,
          .score_sum = detection.score,
          .first_frame = frame_index,
          .last_frame = frame_index,
          .active = true,
      });
    }
  }

  [[nodiscard]] std::set<int> accepted_track_ids(double box_threshold) const {
    std::set<int> accepted;
    for (const Track& track : tracks_) {
      const double mean_score = track.score_sum / std::max(1, track.hits);
      // Two temporally coherent samples are accepted. A single sample is retained
      // only when the detector is substantially more confident than the configured
      // floor, so short subtitle flashes are not categorically lost.
      if (track.hits >= 2 || mean_score >= std::max(0.72, box_threshold + 0.12)) {
        accepted.insert(track.id);
      }
    }
    return accepted;
  }

 private:
  int max_gap_samples_ = 0;
  int next_track_id_ = 1;
  std::vector<Track> tracks_;
};

[[nodiscard]] DetectionTimeline detect_timeline(
    const fs::path& source_path,
    TextDetector& detector,
    const EraseRequest& request,
    const std::atomic_bool& cancelled,
    const ProgressCallback& progress) {
  cv::VideoCapture capture(source_path.string(), cv::CAP_FFMPEG);
  if (!capture.isOpened()) {
    fail("VIDEO_OPEN_FAILED", "failed to open the connected source video");
  }
  const double fps = capture.get(cv::CAP_PROP_FPS);
  const int width = static_cast<int>(capture.get(cv::CAP_PROP_FRAME_WIDTH));
  const int height = static_cast<int>(capture.get(cv::CAP_PROP_FRAME_HEIGHT));
  const double estimated_count = capture.get(cv::CAP_PROP_FRAME_COUNT);
  if (!std::isfinite(fps) || fps <= 0.0 || width <= 0 || height <= 0) {
    fail("VIDEO_METADATA_INVALID", "source video metadata is invalid");
  }
  const cv::Size frame_size(width, height);
  if (width != request.input_width || height != request.input_height) {
    fail("VIDEO_METADATA_MISMATCH",
         "decoded video dimensions differ from the host inspection");
  }
  const cv::Rect search_rect = pixel_search_rect(request.search_region, frame_size);
  const std::int64_t sample_interval = std::max<std::int64_t>(
      1, static_cast<std::int64_t>(std::llround(fps / request.options.detection_fps)));

  TemporalTracker tracker(request.options.max_tracking_gap_samples);
  DetectionTimeline timeline;
  timeline.fps = fps;
  timeline.frame_size = frame_size;
  timeline.search_rect = search_rect;
  cv::Mat frame;
  cv::Mat previous_signature;
  cv::Mat last_frame;
  std::int64_t frame_index = 0;
  std::int64_t last_sampled_index = -1;

  auto sample = [&](const cv::Mat& sample_frame, std::int64_t sample_index) {
    const cv::Mat signature = make_scene_signature(sample_frame);
    const bool scene_cut = is_scene_cut(previous_signature, signature);
    std::vector<Detection> detections =
        detector.detect(sample_frame, search_rect, request.options, cancelled);
    tracker.assign(detections, sample_index, scene_cut);
    timeline.keyframes.push_back({
        .frame_index = sample_index,
        .scene_cut = scene_cut,
        .detections = std::move(detections),
    });
    previous_signature = signature;
    last_sampled_index = sample_index;
  };

  while (capture.read(frame)) {
    check_cancelled(cancelled);
    if (frame.size() != frame_size || frame.type() != CV_8UC3) {
      fail("VIDEO_FRAME_INVALID", "source video frame shape changed");
    }
    if (frame_index % sample_interval == 0) {
      sample(frame, frame_index);
    }
    last_frame = frame.clone();
    ++frame_index;
    if (estimated_count > 0.0 && frame_index % 30 == 0) {
      progress("detect",
               std::min(0.99, static_cast<double>(frame_index) /
                                  estimated_count));
    }
  }
  if (frame_index == 0 || last_frame.empty()) {
    fail("VIDEO_EMPTY", "source video contains no decodable frames");
  }
  if (last_sampled_index != frame_index - 1) {
    sample(last_frame, frame_index - 1);
  }
  timeline.frame_count = frame_index;
  if (request.duration_ms > 0) {
    const double decoded_duration_ms =
        static_cast<double>(frame_index) * 1000.0 / fps;
    const double allowed_difference =
        std::max(1500.0, static_cast<double>(request.duration_ms) * 0.05);
    if (std::abs(decoded_duration_ms -
                 static_cast<double>(request.duration_ms)) >
        allowed_difference) {
      fail("VIDEO_METADATA_MISMATCH",
           "decoded video duration differs from the host inspection");
    }
  }
  timeline.accepted_track_ids =
      tracker.accepted_track_ids(request.options.box_threshold);
  progress("detect", 1.0);

  bool has_mask = false;
  for (const Keyframe& keyframe : timeline.keyframes) {
    if (std::any_of(keyframe.detections.begin(), keyframe.detections.end(),
                    [&](const Detection& detection) {
                      return timeline.accepted_track_ids.contains(
                          detection.track_id);
                    })) {
      has_mask = true;
      break;
    }
  }
  if (!has_mask) {
    fail("NO_SUBTITLE_MASK",
         "no temporally credible text was detected in the selected search region");
  }
  return timeline;
}

[[nodiscard]] int adaptive_dilation(const Keyframe& keyframe,
                                    const std::set<int>& accepted_track_ids,
                                    int configured_pixels) {
  std::vector<float> text_heights;
  for (const Detection& detection : keyframe.detections) {
    if (accepted_track_ids.contains(detection.track_id)) {
      text_heights.push_back(detection.bounds.height);
    }
  }
  if (text_heights.empty()) {
    return configured_pixels;
  }
  const auto middle = text_heights.begin() +
                      static_cast<std::ptrdiff_t>(text_heights.size() / 2U);
  std::nth_element(text_heights.begin(), middle, text_heights.end());
  const int derived =
      std::clamp(static_cast<int>(std::lround(*middle * 0.35F)), 8, 20);
  // Burned-in captions commonly include a solid backing plate a few pixels
  // beyond the OCR polygon. The wider, text-height-relative margin removes that
  // plate with the glyphs while the user's search rectangle still bounds every
  // detector polygon that can enter the mask.
  return std::clamp(std::max(configured_pixels, derived), 8, 20);
}

[[nodiscard]] cv::Mat keyframe_mask(
    const Keyframe& keyframe,
    const DetectionTimeline& timeline,
    const EraseOptions& options) {
  cv::Mat mask = cv::Mat::zeros(timeline.frame_size, CV_8U);
  for (const Detection& detection : keyframe.detections) {
    if (!timeline.accepted_track_ids.contains(detection.track_id)) {
      continue;
    }
    cv::fillPoly(mask, std::vector<std::vector<cv::Point>>{detection.polygon},
                 cv::Scalar(255));
  }
  if (cv::countNonZero(mask) == 0) {
    return mask;
  }
  cv::morphologyEx(mask, mask, cv::MORPH_CLOSE,
                   cv::getStructuringElement(cv::MORPH_ELLIPSE, cv::Size(5, 3)));
  const int dilation = adaptive_dilation(
      keyframe, timeline.accepted_track_ids, options.mask_dilation_pixels);
  cv::dilate(mask, mask,
             cv::getStructuringElement(cv::MORPH_ELLIPSE,
                                       cv::Size(dilation * 2 + 1,
                                                dilation * 2 + 1)));
  cv::Mat search_bounds = cv::Mat::zeros(timeline.frame_size, CV_8U);
  search_bounds(timeline.search_rect).setTo(cv::Scalar(255));
  cv::bitwise_and(mask, search_bounds, mask);
  return mask;
}

[[nodiscard]] cv::Mat dense_flow(const cv::Mat& first,
                                 const cv::Mat& second) {
  cv::Mat first_gray;
  cv::Mat second_gray;
  cv::cvtColor(first, first_gray, cv::COLOR_BGR2GRAY);
  cv::cvtColor(second, second_gray, cv::COLOR_BGR2GRAY);
  // Half-resolution flow is sufficient for subtitle-band background motion,
  // while the vector field is still upscaled to source pixels before the
  // bidirectional consistency and photometric checks below. Bounding the
  // largest ROI dimension avoids quadratic Farneback cost on HD/4K inputs.
  const double scale = temporal_flow_scale(first.cols, first.rows);
  if (scale < 1.0) {
    cv::resize(first_gray, first_gray, cv::Size(), scale, scale, cv::INTER_AREA);
    cv::resize(second_gray, second_gray, cv::Size(), scale, scale,
               cv::INTER_AREA);
  }
  cv::Mat flow;
  cv::calcOpticalFlowFarneback(first_gray, second_gray, flow, 0.5, 3, 15, 3, 5,
                               1.2, 0);
  if (scale < 1.0) {
    cv::resize(flow, flow, first.size(), 0.0, 0.0, cv::INTER_LINEAR);
    flow /= scale;
  }
  return flow;
}

[[nodiscard]] cv::Mat make_flow_map(const cv::Mat& flow) {
  cv::Mat map(flow.size(), CV_32FC2);
  for (int y = 0; y < flow.rows; ++y) {
    const cv::Vec2f* flow_row = flow.ptr<cv::Vec2f>(y);
    cv::Vec2f* map_row = map.ptr<cv::Vec2f>(y);
    for (int x = 0; x < flow.cols; ++x) {
      map_row[x] = cv::Vec2f(static_cast<float>(x) + flow_row[x][0],
                            static_cast<float>(y) + flow_row[x][1]);
    }
  }
  return map;
}

[[nodiscard]] cv::Mat remap_with_map(const cv::Mat& source,
                                     const cv::Mat& map,
                                     int interpolation,
                                     int border_mode) {
  cv::Mat output;
  cv::remap(source, output, map, cv::Mat(), interpolation, border_mode);
  return output;
}

[[nodiscard]] cv::Mat flow_consistency_mask(
    const cv::Mat& target_to_source,
    const cv::Mat& source_to_target,
    const cv::Mat& target_to_source_map) {
  const cv::Mat sampled_reverse = remap_with_map(
      source_to_target, target_to_source_map, cv::INTER_LINEAR,
      cv::BORDER_CONSTANT);
  cv::Mat valid(target_to_source.size(), CV_8U, cv::Scalar(0));
  for (int y = 0; y < target_to_source.rows; ++y) {
    const cv::Vec2f* direct_row = target_to_source.ptr<cv::Vec2f>(y);
    const cv::Vec2f* reverse_row = sampled_reverse.ptr<cv::Vec2f>(y);
    unsigned char* valid_row = valid.ptr<unsigned char>(y);
    for (int x = 0; x < target_to_source.cols; ++x) {
      const cv::Vec2f sum = direct_row[x] + reverse_row[x];
      const float error = std::sqrt(sum.dot(sum));
      const float magnitude =
          std::sqrt(direct_row[x].dot(direct_row[x])) +
          std::sqrt(reverse_row[x].dot(reverse_row[x]));
      if (error <= 1.5F + 0.05F * magnitude) {
        valid_row[x] = 255U;
      }
    }
  }
  return valid;
}

[[nodiscard]] FlowField prepare_flow_field(
    const cv::Mat& target_to_source,
    const cv::Mat& source_to_target) {
  FlowField field;
  field.map = make_flow_map(target_to_source);
  field.consistency = flow_consistency_mask(
      target_to_source, source_to_target, field.map);
  return field;
}

[[nodiscard]] std::vector<FlowPair> calculate_flows(
    const std::vector<cv::Mat>& frames,
    const std::atomic_bool& cancelled,
    const UnitProgressCallback& progress) {
  std::vector<FlowPair> flows;
  if (frames.size() < 2U) {
    progress(1.0);
    return flows;
  }
  flows.reserve(frames.size() - 1U);
  for (std::size_t index = 0; index + 1U < frames.size(); ++index) {
    check_cancelled(cancelled);
    const cv::Mat forward = dense_flow(frames[index], frames[index + 1U]);
    const cv::Mat backward = dense_flow(frames[index + 1U], frames[index]);
    flows.push_back({
        .forward = prepare_flow_field(forward, backward),
        .backward = prepare_flow_field(backward, forward),
    });
    progress(static_cast<double>(index + 1U) /
             static_cast<double>(frames.size() - 1U));
  }
  return flows;
}

[[nodiscard]] cv::Mat propagate_mask(const cv::Mat& source_mask,
                                     const FlowField& target_to_source) {
  cv::Mat warped = remap_with_map(source_mask, target_to_source.map,
                                  cv::INTER_NEAREST, cv::BORDER_CONSTANT);
  cv::bitwise_and(warped, target_to_source.consistency, warped);
  cv::threshold(warped, warped, 127.0, 255.0, cv::THRESH_BINARY);
  return warped;
}

[[nodiscard]] std::vector<cv::Mat> interpolate_masks(
    const cv::Mat& start_mask,
    const cv::Mat& end_mask,
    bool cut_at_end,
    const std::vector<FlowPair>& flows) {
  const std::size_t frame_count = flows.size() + 1U;
  std::vector<cv::Mat> forward(frame_count);
  std::vector<cv::Mat> backward(frame_count);
  forward[0] = start_mask;
  for (std::size_t index = 1; index < frame_count; ++index) {
    forward[index] =
        propagate_mask(forward[index - 1U], flows[index - 1U].backward);
  }
  backward[frame_count - 1U] = end_mask;
  for (std::size_t index = frame_count - 1U; index > 0U; --index) {
    backward[index - 1U] =
        propagate_mask(backward[index], flows[index - 1U].forward);
  }

  std::vector<cv::Mat> masks(frame_count);
  for (std::size_t index = 0; index < frame_count; ++index) {
    if (cut_at_end) {
      masks[index] = index + 1U == frame_count ? end_mask : forward[index];
    } else {
      cv::bitwise_or(forward[index], backward[index], masks[index]);
    }
    cv::morphologyEx(
        masks[index], masks[index], cv::MORPH_CLOSE,
        cv::getStructuringElement(cv::MORPH_ELLIPSE, cv::Size(3, 3)));
  }
  return masks;
}

[[nodiscard]] WarpedCandidate warp_candidate(
    const cv::Mat& source_candidate,
    const cv::Mat& source_original,
    const cv::Mat& source_valid,
    const cv::Mat& target_original,
    const cv::Mat& target_mask,
    const FlowField& target_to_source) {
  WarpedCandidate result;
  result.image = remap_with_map(source_candidate, target_to_source.map,
                                cv::INTER_LINEAR, cv::BORDER_REFLECT_101);
  cv::Mat warped_original = remap_with_map(
      source_original, target_to_source.map, cv::INTER_LINEAR,
      cv::BORDER_REFLECT_101);
  result.valid = remap_with_map(source_valid, target_to_source.map,
                                cv::INTER_NEAREST, cv::BORDER_CONSTANT);
  cv::bitwise_and(result.valid, target_to_source.consistency, result.valid);

  cv::Mat difference;
  cv::absdiff(warped_original, target_original, difference);
  std::vector<cv::Mat> difference_channels;
  cv::split(difference, difference_channels);
  cv::Mat mean_difference;
  cv::addWeighted(difference_channels[0], 1.0 / 3.0, difference_channels[1],
                  1.0 / 3.0, 0.0, mean_difference);
  cv::addWeighted(mean_difference, 1.0, difference_channels[2], 1.0 / 3.0, 0.0,
                  mean_difference);

  cv::Mat expanded_mask;
  cv::dilate(target_mask, expanded_mask,
             cv::getStructuringElement(cv::MORPH_ELLIPSE, cv::Size(9, 9)));
  cv::Mat boundary;
  cv::subtract(expanded_mask, target_mask, boundary);
  cv::bitwise_and(boundary, result.valid, boundary);
  const double boundary_error =
      cv::countNonZero(boundary) > 0 ? cv::mean(mean_difference, boundary)[0]
                                    : std::numeric_limits<double>::infinity();

  cv::Mat photo_valid;
  cv::threshold(mean_difference, photo_valid, 45.0, 255.0, cv::THRESH_BINARY_INV);
  photo_valid.convertTo(photo_valid, CV_8U);
  cv::Mat outside_mask;
  cv::bitwise_not(target_mask, outside_mask);
  cv::Mat outside_photo;
  cv::bitwise_and(photo_valid, outside_mask, outside_photo);
  cv::Mat inside_allowed = cv::Mat::zeros(target_mask.size(), CV_8U);
  if (boundary_error <= 40.0) {
    inside_allowed = target_mask.clone();
  }
  cv::Mat allowed;
  cv::bitwise_or(outside_photo, inside_allowed, allowed);
  cv::bitwise_and(result.valid, allowed, result.valid);
  return result;
}

void build_temporal_candidates(const std::vector<cv::Mat>& frames,
                               const std::vector<cv::Mat>& masks,
                               const std::vector<FlowPair>& flows,
                               const cv::Mat& start_anchor,
                               const cv::Mat& end_anchor,
                               bool cut_at_end,
                               std::vector<cv::Mat>& forward_images,
                               std::vector<cv::Mat>& forward_valid,
                               std::vector<cv::Mat>& backward_images,
                               std::vector<cv::Mat>& backward_valid) {
  const std::size_t count = frames.size();
  forward_images.resize(count);
  forward_valid.resize(count);
  backward_images.resize(count);
  backward_valid.resize(count);

  forward_images[0] = start_anchor.clone();
  forward_valid[0] = cv::Mat(masks[0].size(), CV_8U, cv::Scalar(255));
  for (std::size_t index = 1; index < count; ++index) {
    const WarpedCandidate warped = warp_candidate(
        forward_images[index - 1U], frames[index - 1U],
        forward_valid[index - 1U], frames[index], masks[index],
        flows[index - 1U].backward);
    // Keep the complete anchor warp, including pixels rejected by the
    // confidence gate. Trusted pixels are still tracked separately in
    // forward_valid, while the complete warp is the deterministic P0 fallback
    // for subtitle pixels that would otherwise require per-frame LaMa.
    forward_images[index] = warped.image;
    cv::bitwise_not(masks[index], forward_valid[index]);
    cv::bitwise_or(forward_valid[index], warped.valid, forward_valid[index]);
  }

  for (std::size_t index = 0; index < count; ++index) {
    backward_images[index] = frames[index].clone();
    cv::bitwise_not(masks[index], backward_valid[index]);
  }
  backward_images[count - 1U] = end_anchor.clone();
  backward_valid[count - 1U] =
      cv::Mat(masks[count - 1U].size(), CV_8U, cv::Scalar(255));
  if (!cut_at_end) {
    for (std::size_t index = count - 1U; index > 0U; --index) {
      const WarpedCandidate warped = warp_candidate(
          backward_images[index], frames[index], backward_valid[index],
          frames[index - 1U], masks[index - 1U],
          flows[index - 1U].forward);
      // As in the forward pass, retain the un-gated anchor warp for the nearest
      // anchor fallback while keeping confidence in a separate mask.
      backward_images[index - 1U] = warped.image;
      cv::bitwise_not(masks[index - 1U], backward_valid[index - 1U]);
      cv::bitwise_or(backward_valid[index - 1U], warped.valid,
                     backward_valid[index - 1U]);
    }
  }
}

[[nodiscard]] cv::Mat apply_temporal_fill(
    const cv::Mat& frame,
    const cv::Mat& mask,
    const cv::Mat& forward_image,
    const cv::Mat& forward_valid,
    const cv::Mat& backward_image,
    const cv::Mat& backward_valid,
    const cv::Mat& nearest_anchor_warp) {
  cv::Mat filled = frame.clone();
  for (int y = 0; y < frame.rows; ++y) {
    const unsigned char* mask_row = mask.ptr<unsigned char>(y);
    const unsigned char* forward_valid_row =
        forward_valid.ptr<unsigned char>(y);
    const unsigned char* backward_valid_row =
        backward_valid.ptr<unsigned char>(y);
    const cv::Vec3b* forward_row = forward_image.ptr<cv::Vec3b>(y);
    const cv::Vec3b* backward_row = backward_image.ptr<cv::Vec3b>(y);
    const cv::Vec3b* fallback_row =
        nearest_anchor_warp.ptr<cv::Vec3b>(y);
    cv::Vec3b* filled_row = filled.ptr<cv::Vec3b>(y);
    for (int x = 0; x < frame.cols; ++x) {
      if (mask_row[x] == 0U) {
        continue;
      }
      const bool has_forward = forward_valid_row[x] != 0U;
      const bool has_backward = backward_valid_row[x] != 0U;
      bool accepted = false;
      if (has_forward && has_backward) {
        const cv::Vec3i forward_color(
            forward_row[x][0], forward_row[x][1], forward_row[x][2]);
        const cv::Vec3i backward_color(
            backward_row[x][0], backward_row[x][1], backward_row[x][2]);
        const cv::Vec3i difference = forward_color - backward_color;
        if (cv::norm(difference) <= 60.0) {
          for (int channel = 0; channel < 3; ++channel) {
            filled_row[x][channel] = static_cast<unsigned char>(
                (static_cast<int>(forward_row[x][channel]) +
                 static_cast<int>(backward_row[x][channel])) /
                2);
          }
          accepted = true;
        }
      } else if (has_forward) {
        filled_row[x] = forward_row[x];
        accepted = true;
      } else if (has_backward) {
        filled_row[x] = backward_row[x];
        accepted = true;
      }
      if (!accepted) {
        // The nearest completed detector-keyframe anchor is always preferable
        // to another neural inference on this decoded frame. Restricting this
        // fallback to the subtitle mask preserves the original pixels outside
        // the user's selected region.
        filled_row[x] = fallback_row[x];
      }
    }
  }
  return filled;
}

[[nodiscard]] cv::Rect centered_patch(const cv::Point& center,
                                      const cv::Size& frame_size,
                                      int maximum_size) {
  const int width = std::min(maximum_size, frame_size.width);
  const int height = std::min(maximum_size, frame_size.height);
  const int x = std::clamp(center.x - width / 2, 0, frame_size.width - width);
  const int y = std::clamp(center.y - height / 2, 0, frame_size.height - height);
  return {x, y, width, height};
}

[[nodiscard]] std::vector<cv::Rect> residual_patches(const cv::Mat& residual,
                                                     int maximum_size) {
  std::vector<std::vector<cv::Point>> contours;
  cv::Mat contour_input = residual.clone();
  cv::findContours(contour_input, contours, cv::RETR_EXTERNAL,
                   cv::CHAIN_APPROX_SIMPLE);
  std::set<std::tuple<int, int, int, int>> unique;
  std::vector<cv::Rect> patches;
  const int stride = maximum_size - 128;
  for (const std::vector<cv::Point>& contour : contours) {
    cv::Rect bounds = cv::boundingRect(contour);
    bounds.x = std::max(0, bounds.x - 64);
    bounds.y = std::max(0, bounds.y - 64);
    bounds.width = std::min(residual.cols - bounds.x, bounds.width + 128);
    bounds.height = std::min(residual.rows - bounds.y, bounds.height + 128);

    if (bounds.width <= maximum_size && bounds.height <= maximum_size) {
      const cv::Point center(bounds.x + bounds.width / 2,
                             bounds.y + bounds.height / 2);
      const cv::Rect patch =
          centered_patch(center, residual.size(), maximum_size);
      if (unique.emplace(patch.x, patch.y, patch.width, patch.height).second) {
        patches.push_back(patch);
      }
      continue;
    }

    for (int y = bounds.y; y < bounds.y + bounds.height; y += stride) {
      for (int x = bounds.x; x < bounds.x + bounds.width; x += stride) {
        const cv::Point center(
            std::min(bounds.x + bounds.width - 1, x + maximum_size / 2),
            std::min(bounds.y + bounds.height - 1, y + maximum_size / 2));
        const cv::Rect patch =
            centered_patch(center, residual.size(), maximum_size);
        if (cv::countNonZero(residual(patch)) == 0) {
          continue;
        }
        if (unique.emplace(patch.x, patch.y, patch.width, patch.height).second) {
          patches.push_back(patch);
        }
      }
    }
  }
  return patches;
}

class LamaInpainter final {
 public:
  explicit LamaInpainter(const fs::path& model_path) {
    try {
      network_ = cv::dnn::readNetFromONNX(model_path.string());
      network_.setPreferableBackend(cv::dnn::DNN_BACKEND_OPENCV);
      network_.setPreferableTarget(cv::dnn::DNN_TARGET_CPU);
    } catch (const cv::Exception&) {
      fail("INPAINTER_LOAD_FAILED", "failed to load the pinned LaMa model");
    }
    if (network_.empty()) {
      fail("INPAINTER_LOAD_FAILED", "the pinned LaMa model is empty");
    }
  }

  void fill_residual(cv::Mat& candidate,
                     const cv::Mat& residual,
                     int patch_size,
                     const std::atomic_bool& cancelled,
                     const UnitProgressCallback& progress) {
    if (cv::countNonZero(residual) == 0) {
      progress(1.0);
      return;
    }
    if (patch_size != 512) {
      fail("INPAINTER_CONTRACT_INVALID", "LaMa patch size must be 512");
    }
    const std::vector<cv::Rect> patches =
        residual_patches(residual, patch_size);
    if (patches.empty()) {
      fail("INPAINTER_MASK_INVALID", "residual mask produced no LaMa patches");
    }
    for (std::size_t patch_index = 0; patch_index < patches.size();
         ++patch_index) {
      const cv::Rect& patch = patches[patch_index];
      check_cancelled(cancelled);
      progress(static_cast<double>(patch_index) /
               static_cast<double>(patches.size()));
      cv::Mat patch_image = candidate(patch).clone();
      cv::Mat patch_mask = residual(patch).clone();
      const int bottom_padding = patch_size - patch.height;
      const int right_padding = patch_size - patch.width;
      cv::copyMakeBorder(patch_image, patch_image, 0, bottom_padding, 0,
                         right_padding, cv::BORDER_REFLECT_101);
      cv::copyMakeBorder(patch_mask, patch_mask, 0, bottom_padding, 0,
                         right_padding, cv::BORDER_CONSTANT, cv::Scalar(0));

      const cv::Mat image_blob = cv::dnn::blobFromImage(
          patch_image, 1.0 / 255.0, cv::Size(patch_size, patch_size),
          cv::Scalar(), false, false, CV_32F);
      cv::Mat mask_float;
      patch_mask.convertTo(mask_float, CV_32F, 1.0 / 255.0);
      const int mask_dimensions[] = {1, 1, patch_size, patch_size};
      cv::Mat mask_blob(4, mask_dimensions, CV_32F, cv::Scalar(0));
      std::copy(mask_float.ptr<float>(),
                mask_float.ptr<float>() + mask_float.total(),
                mask_blob.ptr<float>());

      cv::Mat output;
      try {
        // The provisioner pins OpenCV Foundation's LaMa ONNX contract. Named
        // inputs make a mismatched checkpoint fail closed instead of silently
        // feeding the mask into the image tensor or vice versa.
        network_.setInput(image_blob, "image");
        network_.setInput(mask_blob, "mask");
        output = network_.forward();
      } catch (const cv::Exception&) {
        fail("INPAINTER_INFERENCE_FAILED", "LaMa patch inference failed");
      }
      check_cancelled(cancelled);
      if (output.dims != 4 || output.size[0] != 1 || output.size[1] != 3 ||
          output.size[2] != patch_size || output.size[3] != patch_size) {
        fail("INPAINTER_OUTPUT_INVALID",
             "LaMa returned an unsupported output tensor");
      }
      std::vector<cv::Mat> output_images;
      cv::dnn::imagesFromBlob(output, output_images);
      if (output_images.size() != 1U ||
          output_images.front().size() != cv::Size(patch_size, patch_size) ||
          output_images.front().type() != CV_32FC3) {
        fail("INPAINTER_OUTPUT_INVALID", "LaMa output image is invalid");
      }
      // The OpenCV LaMa checkpoint returns BGR samples in the 0..255 float
      // range. It is not a normalized RGB tensor.
      cv::Mat output_bgr = output_images.front().clone();
      cv::min(output_bgr, 255.0, output_bgr);
      cv::max(output_bgr, 0.0, output_bgr);
      output_bgr.convertTo(output_bgr, CV_8UC3);

      cv::Mat output_crop = output_bgr(cv::Rect(0, 0, patch.width, patch.height));
      cv::Mat destination = candidate(patch);
      output_crop.copyTo(destination,
                         patch_mask(cv::Rect(0, 0, patch.width, patch.height)));
      progress(static_cast<double>(patch_index + 1U) /
               static_cast<double>(patches.size()));
    }

    // Every residual pixel must be covered by at least one patch. Never fall back
    // to cv::inpaint/delogo when the neural model contract is not satisfied.
    cv::Mat covered = cv::Mat::zeros(residual.size(), CV_8U);
    for (const cv::Rect& patch : patches) {
      residual(patch).copyTo(covered(patch));
    }
    cv::Mat missing;
    cv::subtract(residual, covered, missing);
    if (cv::countNonZero(missing) != 0) {
      fail("INPAINTER_MASK_INVALID", "LaMa patches did not cover the residual mask");
    }
  }

 private:
  cv::dnn::Net network_;
};

[[nodiscard]] cv::Mat composite_inside_mask(const cv::Mat& original,
                                            const cv::Mat& candidate,
                                            const cv::Mat& mask) {
  if (cv::countNonZero(mask) == 0) {
    return original.clone();
  }
  cv::Mat distance;
  cv::distanceTransform(mask, distance, cv::DIST_L2, 3);
  cv::Mat result = original.clone();
  constexpr float feather_width = 3.0F;
  for (int y = 0; y < original.rows; ++y) {
    const unsigned char* mask_row = mask.ptr<unsigned char>(y);
    const float* distance_row = distance.ptr<float>(y);
    const cv::Vec3b* original_row = original.ptr<cv::Vec3b>(y);
    const cv::Vec3b* candidate_row = candidate.ptr<cv::Vec3b>(y);
    cv::Vec3b* result_row = result.ptr<cv::Vec3b>(y);
    for (int x = 0; x < original.cols; ++x) {
      if (mask_row[x] == 0U) {
        continue;
      }
      const float alpha =
          std::clamp(distance_row[x] / feather_width, 0.0F, 1.0F);
      for (int channel = 0; channel < 3; ++channel) {
        result_row[x][channel] = static_cast<unsigned char>(std::lround(
            original_row[x][channel] * (1.0F - alpha) +
            candidate_row[x][channel] * alpha));
      }
    }
  }
  return result;
}

[[nodiscard]] cv::Mat build_inpainted_anchor(
    const cv::Mat& frame,
    const cv::Mat& mask,
    LamaInpainter& inpainter,
    const EraseOptions& options,
    const std::atomic_bool& cancelled,
    const UnitProgressCallback& progress) {
  cv::Mat anchor = frame.clone();
  if (cv::countNonZero(mask) == 0) {
    progress(1.0);
    return anchor;
  }
  inpainter.fill_residual(anchor, mask, options.max_lama_patch, cancelled,
                          progress);
  return anchor;
}

[[nodiscard]] std::vector<cv::Mat> erase_segment(
    const std::vector<cv::Mat>& frames,
    const cv::Mat& start_mask,
    const cv::Mat& end_mask,
    const cv::Mat& start_anchor,
    const cv::Mat& end_anchor,
    const cv::Rect& temporal_rect,
    bool cut_at_end,
    const std::atomic_bool& cancelled,
    const UnitProgressCallback& progress) {
  std::vector<cv::Mat> temporal_frames;
  temporal_frames.reserve(frames.size());
  for (const cv::Mat& frame : frames) {
    temporal_frames.push_back(frame(temporal_rect));
  }
  const cv::Mat temporal_start_mask = start_mask(temporal_rect);
  const cv::Mat temporal_end_mask = end_mask(temporal_rect);
  const cv::Mat temporal_start_anchor = start_anchor(temporal_rect);
  const cv::Mat temporal_end_anchor = end_anchor(temporal_rect);

  const std::vector<FlowPair> flows = calculate_flows(
      temporal_frames, cancelled,
      [&](double value) { progress(value * 0.25); });
  const std::vector<cv::Mat> masks =
      interpolate_masks(temporal_start_mask, temporal_end_mask, cut_at_end,
                        flows);
  std::vector<cv::Mat> forward_images;
  std::vector<cv::Mat> forward_valid;
  std::vector<cv::Mat> backward_images;
  std::vector<cv::Mat> backward_valid;
  build_temporal_candidates(temporal_frames, masks, flows,
                            temporal_start_anchor, temporal_end_anchor,
                            cut_at_end, forward_images, forward_valid,
                            backward_images, backward_valid);
  progress(0.30);

  std::vector<cv::Mat> results;
  results.reserve(frames.size());
  for (std::size_t index = 0; index < frames.size(); ++index) {
    check_cancelled(cancelled);
    const double frame_end =
        0.30 + 0.70 * static_cast<double>(index + 1U) /
                   static_cast<double>(frames.size());
    if (cv::countNonZero(masks[index]) == 0) {
      results.push_back(frames[index].clone());
      progress(frame_end);
      continue;
    }
    cv::Mat temporal_result;
    if (index == 0U) {
      temporal_result = composite_inside_mask(
          temporal_frames[index], temporal_start_anchor, masks[index]);
      results.push_back(stitch_temporal_result(
          frames[index], temporal_result, temporal_rect));
      progress(frame_end);
      continue;
    }
    if (index + 1U == frames.size()) {
      temporal_result = composite_inside_mask(
          temporal_frames[index], temporal_end_anchor, masks[index]);
      results.push_back(stitch_temporal_result(
          frames[index], temporal_result, temporal_rect));
      progress(frame_end);
      continue;
    }
    const bool use_forward_fallback =
        cut_at_end || index * 2U <= frames.size() - 1U;
    const cv::Mat& nearest_anchor_warp =
        use_forward_fallback ? forward_images[index] : backward_images[index];
    const cv::Mat candidate = apply_temporal_fill(
        temporal_frames[index], masks[index], forward_images[index],
        forward_valid[index], backward_images[index], backward_valid[index],
        nearest_anchor_warp);
    temporal_result = composite_inside_mask(
        temporal_frames[index], candidate, masks[index]);
    results.push_back(stitch_temporal_result(
        frames[index], temporal_result, temporal_rect));
    progress(frame_end);
  }
  return results;
}

void require_absent(const fs::path& path, std::string_view label) {
  std::error_code error;
  const bool exists = fs::exists(path, error);
  if (error || exists) {
    fail("OUTPUT_CONFLICT", std::string(label) + " already exists");
  }
}

void write_processed_video(const fs::path& source_path,
                           const fs::path& silent_video_path,
                           const DetectionTimeline& timeline,
                           LamaInpainter& inpainter,
                           const EraseOptions& options,
                           const std::atomic_bool& cancelled,
                           const ProgressCallback& progress) {
  cv::VideoCapture capture(source_path.string(), cv::CAP_FFMPEG);
  if (!capture.isOpened()) {
    fail("VIDEO_REOPEN_FAILED", "failed to reopen source video for erasure");
  }
  const int codec = cv::VideoWriter::fourcc('F', 'F', 'V', '1');
  cv::VideoWriter writer(silent_video_path.string(), cv::CAP_FFMPEG, codec,
                         timeline.fps, timeline.frame_size, true);
  if (!writer.isOpened()) {
    fail("VIDEO_ENCODER_UNAVAILABLE",
         "the packaged OpenCV runtime cannot encode the intermediate video");
  }

  std::int64_t next_index_to_read = 0;
  std::int64_t written_frames = 0;
  cv::Mat carried_frame;
  cv::Mat carried_anchor;
  std::int64_t carried_anchor_index = -1;
  const PixelRegion temporal_region = padded_temporal_region(
      {
          .x = timeline.search_rect.x,
          .y = timeline.search_rect.y,
          .width = timeline.search_rect.width,
          .height = timeline.search_rect.height,
      },
      timeline.frame_size.width, timeline.frame_size.height);
  const cv::Rect temporal_rect(temporal_region.x, temporal_region.y,
                               temporal_region.width, temporal_region.height);
  progress("erase", 0.0);
  if (timeline.keyframes.size() == 1U) {
    cv::Mat frame;
    if (!capture.read(frame)) {
      fail("VIDEO_DECODE_FAILED", "failed to decode the source video");
    }
    const cv::Mat mask = keyframe_mask(timeline.keyframes.front(), timeline, options);
    const cv::Mat anchor = build_inpainted_anchor(
        frame, mask, inpainter, options, cancelled,
        [&](double value) { progress("erase", value * 0.90); });
    writer.write(composite_inside_mask(frame, anchor, mask));
    writer.release();
    progress("erase", 1.0);
    return;
  }

  for (std::size_t segment_index = 0;
       segment_index + 1U < timeline.keyframes.size(); ++segment_index) {
    check_cancelled(cancelled);
    const Keyframe& start = timeline.keyframes[segment_index];
    const Keyframe& end = timeline.keyframes[segment_index + 1U];
    if (end.frame_index <= start.frame_index) {
      fail("TIMELINE_INVALID", "detector keyframes are not strictly ordered");
    }
    std::vector<cv::Mat> frames;
    frames.reserve(static_cast<std::size_t>(end.frame_index - start.frame_index + 1));
    if (!carried_frame.empty()) {
      frames.push_back(carried_frame);
    }
    while (next_index_to_read <= end.frame_index) {
      cv::Mat frame;
      if (!capture.read(frame)) {
        fail("VIDEO_DECODE_FAILED", "source video ended before its detected timeline");
      }
      if (next_index_to_read >= start.frame_index) {
        frames.push_back(frame.clone());
      }
      ++next_index_to_read;
    }
    const std::size_t expected_frames =
        static_cast<std::size_t>(end.frame_index - start.frame_index + 1);
    if (frames.size() != expected_frames) {
      fail("TIMELINE_INVALID", "decoded segment length does not match keyframes");
    }

    const cv::Mat start_mask = keyframe_mask(start, timeline, options);
    const cv::Mat end_mask = keyframe_mask(end, timeline, options);
    const double segment_start =
        static_cast<double>(start.frame_index) /
        static_cast<double>(timeline.frame_count);
    const double segment_span =
        static_cast<double>(end.frame_index - start.frame_index) /
        static_cast<double>(timeline.frame_count);
    const auto report_segment = [&](double value) {
      progress("erase", segment_start + segment_span * value);
    };

    cv::Mat start_anchor;
    if (!carried_anchor.empty() && carried_anchor_index == start.frame_index) {
      start_anchor = carried_anchor;
      report_segment(0.15);
    } else {
      start_anchor = build_inpainted_anchor(
          frames.front(), start_mask, inpainter, options, cancelled,
          [&](double value) { report_segment(value * 0.15); });
    }

    const cv::Mat end_anchor = build_inpainted_anchor(
        frames.back(), end_mask, inpainter, options, cancelled,
        [&](double value) { report_segment(0.15 + value * 0.15); });
    std::vector<cv::Mat> results =
        erase_segment(frames, start_mask, end_mask, start_anchor, end_anchor,
                      temporal_rect, end.scene_cut, cancelled,
                      [&](double value) { report_segment(0.30 + value * 0.70); });
    const bool final_segment = segment_index + 2U == timeline.keyframes.size();
    const std::size_t write_count =
        final_segment ? results.size() : results.size() - 1U;
    for (std::size_t index = 0; index < write_count; ++index) {
      writer.write(results[index]);
      ++written_frames;
    }
    carried_frame = frames.back().clone();
    carried_anchor = end_anchor;
    carried_anchor_index = end.frame_index;
    progress("erase",
             static_cast<double>(written_frames) /
                 static_cast<double>(timeline.frame_count));
  }
  writer.release();
  if (written_frames != timeline.frame_count) {
    fail("VIDEO_ENCODE_FAILED", "processed video frame count is incomplete");
  }
  progress("erase", 1.0);
}

void package_output_streams(const fs::path& ffmpeg,
                            const fs::path& silent_video,
                            const fs::path& source_video,
                            const fs::path& staged_output,
                            const std::atomic_bool& cancelled,
                            const ProgressCallback& progress) {
  progress("remux", 0.0);
  const std::vector<std::string> arguments = {
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      "-n",
      "-i",
      silent_video.string(),
      "-i",
      source_video.string(),
      "-map",
      "0:v:0",
      "-map",
      "1:a?",
      "-map",
      "1:s?",
      "-map_metadata",
      "1",
      "-map_chapters",
      "1",
      "-c:v",
      "h264_videotoolbox",
      "-allow_sw",
      "1",
      "-profile:v",
      "main",
      "-q:v",
      "65",
      "-pix_fmt",
      "yuv420p",
      "-tag:v",
      "avc1",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-c:s",
      "mov_text",
      "-movflags",
      "+faststart",
      staged_output.string(),
  };
  const int exit_code = run_process(ffmpeg, arguments, cancelled);
  check_cancelled(cancelled);
  if (exit_code != 0) {
    fail("FFMPEG_REMUX_FAILED", "ffmpeg failed to remux the processed video");
  }
  progress("remux", 1.0);
}

void validate_output(const fs::path& output,
                     const DetectionTimeline& timeline) {
  std::error_code error;
  const fs::file_status status = fs::symlink_status(output, error);
  if (error || !fs::is_regular_file(status) || fs::is_symlink(status) ||
      fs::file_size(output, error) == 0U || error) {
    fail("OUTPUT_INVALID", "processed output is not a non-empty regular file");
  }
  cv::VideoCapture capture(output.string(), cv::CAP_FFMPEG);
  if (!capture.isOpened()) {
    fail("OUTPUT_INVALID", "processed output cannot be decoded");
  }
  const int width = static_cast<int>(capture.get(cv::CAP_PROP_FRAME_WIDTH));
  const int height = static_cast<int>(capture.get(cv::CAP_PROP_FRAME_HEIGHT));
  const double frame_count = capture.get(cv::CAP_PROP_FRAME_COUNT);
  const double fps = capture.get(cv::CAP_PROP_FPS);
  if (width != timeline.frame_size.width || height != timeline.frame_size.height ||
      !std::isfinite(frame_count) ||
      std::llround(frame_count) != timeline.frame_count ||
      !std::isfinite(fps) || fps <= 0.0 ||
      std::abs(fps - timeline.fps) > std::max(0.05, timeline.fps * 0.01)) {
    fail("OUTPUT_INVALID", "processed output metadata failed validation");
  }
  std::int64_t decoded_frames = 0;
  cv::Mat frame;
  while (capture.read(frame)) {
    if (frame.size() != timeline.frame_size || frame.type() != CV_8UC3 ||
        ++decoded_frames > timeline.frame_count) {
      fail("OUTPUT_INVALID", "processed output frames failed validation");
    }
  }
  if (decoded_frames != timeline.frame_count) {
    fail("OUTPUT_INVALID", "processed output is truncated");
  }
}

}  // namespace

ErasureArtifact erase_hard_subtitles(const EngineDependencies& dependencies,
                                     const EraseRequest& request,
                                     const std::atomic_bool& cancelled,
                                     const ProgressCallback& progress) {
  check_cancelled(cancelled);
  const fs::path work_directory =
      require_directory(dependencies.work_directory, "work directory");
  if (!fs::path(request.source_path).is_absolute() ||
      !fs::path(request.detector_model_path).is_absolute() ||
      !fs::path(request.inpainting_model_path).is_absolute() ||
      !dependencies.ffmpeg_executable.is_absolute()) {
    fail("RUNTIME_INVALID", "source, model and sibling ffmpeg paths must be absolute");
  }
  const fs::path source_path =
      require_regular_file(fs::path(request.source_path), "source video");
  const fs::path detector_model =
      require_regular_file(fs::path(request.detector_model_path), "detector model");
  const fs::path inpaint_model =
      require_regular_file(fs::path(request.inpainting_model_path), "inpaint model");
  const fs::path ffmpeg = require_executable_file(
      dependencies.ffmpeg_executable, "sibling ffmpeg executable");

  const fs::path output_path = work_directory / fs::path(request.output_relative_path);
  const fs::path output_parent =
      require_directory(output_path.parent_path(), "output parent directory");
  if (!is_contained_path(work_directory, output_parent)) {
    fail("OUTPUT_INVALID", "requested output escaped the work directory");
  }
  const fs::path silent_video = work_directory / ".convax-erasure-video.mkv";
  const fs::path staged_output = work_directory / ".convax-erasure-output.mp4";
  require_absent(output_path, "requested output");
  require_absent(silent_video, "intermediate output");
  require_absent(staged_output, "staged output");
  TemporaryArtifacts cleanup({silent_video, staged_output});

  TextDetector detector(detector_model);
  LamaInpainter inpainter(inpaint_model);
  const DetectionTimeline timeline = detect_timeline(
      source_path, detector, request, cancelled, progress);
  write_processed_video(source_path, silent_video, timeline, inpainter,
                        request.options, cancelled, progress);
  package_output_streams(ffmpeg, silent_video, source_path, staged_output,
                         cancelled, progress);
  progress("validate", 0.0);
  validate_output(staged_output, timeline);

  std::error_code error;
  fs::rename(staged_output, output_path, error);
  if (error) {
    fail("OUTPUT_PUBLISH_FAILED", "failed to publish the processed video atomically");
  }
  progress("validate", 1.0);
  const double duration_seconds =
      static_cast<double>(timeline.frame_count) / timeline.fps;
  return {
      .relative_path = request.output_relative_path,
      .frame_count = timeline.frame_count,
      .width = timeline.frame_size.width,
      .height = timeline.frame_size.height,
      .duration_seconds = duration_seconds,
  };
}

}  // namespace convax::subtitle_erasure
