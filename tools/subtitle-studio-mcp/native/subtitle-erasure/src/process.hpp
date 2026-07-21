#pragma once

#include <atomic>
#include <filesystem>
#include <string>
#include <vector>

namespace convax::subtitle_erasure {

[[nodiscard]] int run_process(const std::filesystem::path& executable,
                              const std::vector<std::string>& arguments,
                              const std::atomic_bool& cancelled);

}  // namespace convax::subtitle_erasure
