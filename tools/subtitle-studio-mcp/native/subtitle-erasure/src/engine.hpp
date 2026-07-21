#pragma once

#include "protocol.hpp"

#include <atomic>
#include <filesystem>
#include <functional>
#include <string>

namespace convax::subtitle_erasure {

struct EngineDependencies {
  std::filesystem::path ffmpeg_executable;
  std::filesystem::path work_directory;
};

struct ErasureArtifact {
  std::string relative_path;
  std::int64_t frame_count = 0;
  int width = 0;
  int height = 0;
  double duration_seconds = 0.0;
};

using ProgressCallback = std::function<void(const std::string&, double)>;

[[nodiscard]] ErasureArtifact erase_hard_subtitles(
    const EngineDependencies& dependencies,
    const EraseRequest& request,
    const std::atomic_bool& cancelled,
    const ProgressCallback& progress);

}  // namespace convax::subtitle_erasure
