#include "protocol.hpp"

#include <iostream>
#include <sstream>
#include <string>

namespace {

std::string request_with_region_x(std::string x) {
  return "{\"protocolVersion\":1,\"operation\":\"erase-hard-subtitles\","
         "\"input\":{\"path\":\"/tmp/source.mp4\",\"width\":1920,"
         "\"height\":1080,\"durationMs\":6000},"
         "\"models\":{\"detectorPath\":\"/tmp/detector.onnx\","
         "\"inpaintingPath\":\"/tmp/lama.onnx\"},"
         "\"region\":{\"x\":" +
         x +
         ",\"y\":778,\"width\":1612,\"height\":238},"
         "\"output\":{\"path\":\"subtitle-erased.mp4\"}}";
}

bool rejects(std::string input) {
  try {
    std::istringstream stream{input};
    static_cast<void>(convax::subtitle_erasure::read_request(stream));
    return false;
  } catch (const convax::subtitle_erasure::ProtocolError&) {
    return true;
  }
}

}  // namespace

int main() {
  int failures = 0;
  const auto require = [&failures](bool condition, const char* message) {
    if (condition) return;
    std::cerr << message << '\n';
    ++failures;
  };

  std::istringstream integer_input{request_with_region_x("154")};
  const auto integer =
      convax::subtitle_erasure::read_request(integer_input);
  require(integer.search_region.x == 154, "integer JSON number was not parsed");
  require(integer.options.detection_fps == 2.0,
          "default detector cadence changed unexpectedly");

  std::istringstream exponent_input{request_with_region_x("154e0")};
  const auto exponent =
      convax::subtitle_erasure::read_request(exponent_input);
  require(exponent.search_region.x == 154,
          "exponent JSON number was not parsed");

  require(rejects(request_with_region_x("154.5")),
          "fractional pixel coordinate was accepted");
  require(rejects(request_with_region_x("1e9999")),
          "non-finite JSON number was accepted");
  require(rejects(request_with_region_x("01")),
          "JSON number with a leading zero was accepted");

  std::ostringstream output;
  convax::subtitle_erasure::emit_progress(output, "detect", 0.5);
  require(output.str() ==
              "{\"protocolVersion\":1,\"type\":\"progress\",\"progress\":0.5000,"
              "\"stage\":\"detect\"}\n",
          "progress event did not match the bounded protocol");
  return failures == 0 ? 0 : 1;
}
