#include "engine.hpp"
#include "protocol.hpp"

#include <algorithm>
#include <atomic>
#include <csignal>
#include <cstdint>
#include <exception>
#include <filesystem>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

#if defined(__APPLE__)
#include <mach-o/dyld.h>
#elif defined(__linux__)
#include <unistd.h>
#endif

namespace {

namespace fs = std::filesystem;

std::atomic_bool g_cancelled = false;

extern "C" void handle_termination_signal(int signal_number) {
  static_cast<void>(signal_number);
  g_cancelled.store(true, std::memory_order_relaxed);
}

[[nodiscard]] fs::path current_executable_path() {
#if defined(__APPLE__)
  std::uint32_t size = 0;
  static_cast<void>(::_NSGetExecutablePath(nullptr, &size));
  std::vector<char> buffer(static_cast<std::size_t>(size) + 1U, '\0');
  if (::_NSGetExecutablePath(buffer.data(), &size) != 0) {
    throw std::runtime_error("failed to resolve the sidecar executable");
  }
  return fs::canonical(fs::path(buffer.data()));
#elif defined(__linux__)
  std::vector<char> buffer(4096U, '\0');
  const ssize_t length =
      ::readlink("/proc/self/exe", buffer.data(), buffer.size() - 1U);
  if (length <= 0 || static_cast<std::size_t>(length) >= buffer.size()) {
    throw std::runtime_error("failed to resolve the sidecar executable");
  }
  buffer[static_cast<std::size_t>(length)] = '\0';
  return fs::canonical(fs::path(buffer.data()));
#else
  throw std::runtime_error("subtitle erasure is unsupported on this platform");
#endif
}

[[nodiscard]] double global_progress(const std::string& stage, double progress) {
  const double bounded = std::clamp(progress, 0.0, 1.0);
  if (stage == "detect") {
    return 0.02 + bounded * 0.23;
  }
  if (stage == "erase") {
    return 0.25 + bounded * 0.65;
  }
  if (stage == "remux") {
    return 0.90 + bounded * 0.08;
  }
  if (stage == "validate") {
    return 0.98 + bounded * 0.02;
  }
  throw std::runtime_error("native engine reported an unknown progress stage");
}

}  // namespace

int main(int argc, char** argv) {
  using namespace convax::subtitle_erasure;

  if (argc == 2 && std::string(argv[1]) == "--version") {
    std::cout << "{\"engine\":\"convax-subtitle-erasure\",\"engineVersion\":\""
              << CONVAX_SUBTITLE_ERASURE_VERSION
              << "\",\"protocolVersion\":" << kProtocolVersion << "}\n";
    return 0;
  }

  static_cast<void>(std::signal(SIGINT, handle_termination_signal));
  static_cast<void>(std::signal(SIGTERM, handle_termination_signal));

  try {
    if (argc != 1) {
      throw ProtocolError("INVALID_ARGUMENT",
                          "the sidecar does not accept command-line arguments");
    }
    const EraseRequest request = read_request(std::cin);
    const fs::path executable = current_executable_path();
    const fs::path work_directory = fs::current_path();
    const fs::path sibling_ffmpeg = executable.parent_path() / "ffmpeg";

    double last_progress = 0.0;
    std::string last_stage;
    const ProgressCallback progress = [&](const std::string& stage, double value) {
      const double mapped = global_progress(stage, value);
      if (mapped + 1e-9 < last_progress) {
        throw std::runtime_error("native engine progress moved backwards");
      }
      const bool stage_changed = stage != last_stage;
      if (stage_changed || mapped - last_progress >= 0.002 || mapped >= 1.0) {
        emit_progress(std::cout, stage, mapped);
        last_progress = mapped;
        last_stage = stage;
      }
    };

    const ErasureArtifact artifact = erase_hard_subtitles(
        {
            .ffmpeg_executable = sibling_ffmpeg,
            .work_directory = work_directory,
        },
        request, g_cancelled, progress);
    if (artifact.relative_path != request.output_relative_path) {
      throw std::runtime_error("native engine returned an unexpected output path");
    }
    emit_result(std::cout, artifact.relative_path);
    return 0;
  } catch (const ProtocolError& error) {
    if (error.code() == "CANCELLED" ||
        g_cancelled.load(std::memory_order_relaxed)) {
      return 130;
    }
    emit_error(std::cout, error.message());
    return error.code() == "INVALID_ARGUMENT" ||
                   error.code() == "INVALID_REQUEST" ||
                   error.code() == "UNSUPPORTED_PROTOCOL" ||
                   error.code() == "UNSUPPORTED_OPERATION"
               ? 2
               : 3;
  } catch (const std::exception& error) {
    std::cerr << "convax-subtitle-erasure: " << error.what() << '\n';
    if (g_cancelled.load(std::memory_order_relaxed)) {
      return 130;
    }
    emit_error(std::cout, "native subtitle erasure failed");
    return 3;
  } catch (...) {
    if (!g_cancelled.load(std::memory_order_relaxed)) {
      emit_error(std::cout, "native subtitle erasure failed");
    }
    return g_cancelled.load(std::memory_order_relaxed) ? 130 : 3;
  }
}
