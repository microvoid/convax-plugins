#include "protocol.hpp"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <iomanip>
#include <istream>
#include <limits>
#include <locale>
#include <map>
#include <ostream>
#include <sstream>
#include <stdexcept>
#include <string_view>
#include <utility>
#include <variant>
#include <vector>

namespace convax::subtitle_erasure {
namespace {

class JsonValue final {
 public:
  using Object = std::map<std::string, JsonValue, std::less<>>;
  using Array = std::vector<JsonValue>;
  using Storage =
      std::variant<std::nullptr_t, bool, double, std::string, Object, Array>;

  explicit JsonValue(Storage value) : value_(std::move(value)) {}

  [[nodiscard]] const Object* object() const {
    return std::get_if<Object>(&value_);
  }

  [[nodiscard]] const std::string* string() const {
    return std::get_if<std::string>(&value_);
  }

  [[nodiscard]] const double* number() const {
    return std::get_if<double>(&value_);
  }

 private:
  Storage value_;
};

class JsonParser final {
 public:
  explicit JsonParser(std::string_view input) : input_(input) {}

  [[nodiscard]] JsonValue parse() {
    JsonValue result = parse_value(0);
    skip_whitespace();
    if (position_ != input_.size()) {
      fail("unexpected trailing JSON data");
    }
    return result;
  }

 private:
  static constexpr std::size_t kMaxDepth = 16;

  [[noreturn]] void fail(const std::string& reason) const {
    throw ProtocolError("INVALID_REQUEST", reason);
  }

  void skip_whitespace() {
    while (position_ < input_.size()) {
      const char character = input_[position_];
      if (character != ' ' && character != '\n' && character != '\r' &&
          character != '\t') {
        break;
      }
      ++position_;
    }
  }

  [[nodiscard]] bool consume(char expected) {
    skip_whitespace();
    if (position_ >= input_.size() || input_[position_] != expected) {
      return false;
    }
    ++position_;
    return true;
  }

  void expect(char expected) {
    if (!consume(expected)) {
      fail(std::string("expected '") + expected + "'");
    }
  }

  [[nodiscard]] JsonValue parse_value(std::size_t depth) {
    if (depth > kMaxDepth) {
      fail("JSON nesting is too deep");
    }
    skip_whitespace();
    if (position_ >= input_.size()) {
      fail("unexpected end of JSON");
    }

    switch (input_[position_]) {
      case '{':
        return JsonValue(parse_object(depth + 1));
      case '[':
        return JsonValue(parse_array(depth + 1));
      case '"':
        return JsonValue(parse_string());
      case 't':
        consume_literal("true");
        return JsonValue(true);
      case 'f':
        consume_literal("false");
        return JsonValue(false);
      case 'n':
        consume_literal("null");
        return JsonValue(nullptr);
      default:
        if (input_[position_] == '-' ||
            (input_[position_] >= '0' && input_[position_] <= '9')) {
          return JsonValue(parse_number());
        }
        fail("unexpected JSON token");
    }
  }

  [[nodiscard]] JsonValue::Object parse_object(std::size_t depth) {
    expect('{');
    JsonValue::Object object;
    if (consume('}')) {
      return object;
    }

    while (true) {
      skip_whitespace();
      if (position_ >= input_.size() || input_[position_] != '"') {
        fail("object key must be a string");
      }
      std::string key = parse_string();
      expect(':');
      auto [iterator, inserted] =
          object.emplace(std::move(key), parse_value(depth));
      static_cast<void>(iterator);
      if (!inserted) {
        fail("duplicate object key");
      }
      if (consume('}')) {
        return object;
      }
      expect(',');
    }
  }

  [[nodiscard]] JsonValue::Array parse_array(std::size_t depth) {
    expect('[');
    JsonValue::Array array;
    if (consume(']')) {
      return array;
    }
    while (true) {
      array.push_back(parse_value(depth));
      if (consume(']')) {
        return array;
      }
      expect(',');
    }
  }

  [[nodiscard]] static std::uint32_t hex_digit(char character) {
    if (character >= '0' && character <= '9') {
      return static_cast<std::uint32_t>(character - '0');
    }
    if (character >= 'a' && character <= 'f') {
      return 10U + static_cast<std::uint32_t>(character - 'a');
    }
    if (character >= 'A' && character <= 'F') {
      return 10U + static_cast<std::uint32_t>(character - 'A');
    }
    throw ProtocolError("INVALID_REQUEST", "invalid JSON unicode escape");
  }

  [[nodiscard]] std::uint32_t parse_hex4() {
    if (input_.size() - position_ < 4U) {
      fail("truncated JSON unicode escape");
    }
    std::uint32_t value = 0;
    for (int index = 0; index < 4; ++index) {
      value = (value << 4U) | hex_digit(input_[position_++]);
    }
    return value;
  }

  static void append_utf8(std::string& output, std::uint32_t codepoint) {
    if (codepoint <= 0x7FU) {
      output.push_back(static_cast<char>(codepoint));
      return;
    }
    if (codepoint <= 0x7FFU) {
      output.push_back(static_cast<char>(0xC0U | (codepoint >> 6U)));
      output.push_back(static_cast<char>(0x80U | (codepoint & 0x3FU)));
      return;
    }
    if (codepoint <= 0xFFFFU) {
      output.push_back(static_cast<char>(0xE0U | (codepoint >> 12U)));
      output.push_back(
          static_cast<char>(0x80U | ((codepoint >> 6U) & 0x3FU)));
      output.push_back(static_cast<char>(0x80U | (codepoint & 0x3FU)));
      return;
    }
    output.push_back(static_cast<char>(0xF0U | (codepoint >> 18U)));
    output.push_back(static_cast<char>(0x80U | ((codepoint >> 12U) & 0x3FU)));
    output.push_back(static_cast<char>(0x80U | ((codepoint >> 6U) & 0x3FU)));
    output.push_back(static_cast<char>(0x80U | (codepoint & 0x3FU)));
  }

  [[nodiscard]] std::string parse_string() {
    if (position_ >= input_.size() || input_[position_] != '"') {
      fail("expected JSON string");
    }
    ++position_;
    std::string value;
    while (position_ < input_.size()) {
      const unsigned char character =
          static_cast<unsigned char>(input_[position_++]);
      if (character == '"') {
        return value;
      }
      if (character < 0x20U) {
        fail("unescaped control character in JSON string");
      }
      if (character != '\\') {
        value.push_back(static_cast<char>(character));
        continue;
      }
      if (position_ >= input_.size()) {
        fail("truncated JSON escape");
      }
      const char escaped = input_[position_++];
      switch (escaped) {
        case '"':
        case '\\':
        case '/':
          value.push_back(escaped);
          break;
        case 'b':
          value.push_back('\b');
          break;
        case 'f':
          value.push_back('\f');
          break;
        case 'n':
          value.push_back('\n');
          break;
        case 'r':
          value.push_back('\r');
          break;
        case 't':
          value.push_back('\t');
          break;
        case 'u': {
          std::uint32_t codepoint = parse_hex4();
          if (codepoint >= 0xD800U && codepoint <= 0xDBFFU) {
            if (input_.size() - position_ < 6U ||
                input_[position_] != '\\' || input_[position_ + 1U] != 'u') {
              fail("missing low surrogate in JSON unicode escape");
            }
            position_ += 2U;
            const std::uint32_t low = parse_hex4();
            if (low < 0xDC00U || low > 0xDFFFU) {
              fail("invalid low surrogate in JSON unicode escape");
            }
            codepoint = 0x10000U + ((codepoint - 0xD800U) << 10U) +
                        (low - 0xDC00U);
          } else if (codepoint >= 0xDC00U && codepoint <= 0xDFFFU) {
            fail("unexpected low surrogate in JSON unicode escape");
          }
          append_utf8(value, codepoint);
          break;
        }
        default:
          fail("invalid JSON escape");
      }
    }
    fail("unterminated JSON string");
  }

  [[nodiscard]] double parse_number() {
    const std::size_t start = position_;
    if (input_[position_] == '-') {
      ++position_;
    }
    if (position_ >= input_.size()) {
      fail("truncated JSON number");
    }
    if (input_[position_] == '0') {
      ++position_;
    } else {
      if (input_[position_] < '1' || input_[position_] > '9') {
        fail("invalid JSON number");
      }
      while (position_ < input_.size() && input_[position_] >= '0' &&
             input_[position_] <= '9') {
        ++position_;
      }
    }
    if (position_ < input_.size() && input_[position_] == '.') {
      ++position_;
      const std::size_t fraction_start = position_;
      while (position_ < input_.size() && input_[position_] >= '0' &&
             input_[position_] <= '9') {
        ++position_;
      }
      if (position_ == fraction_start) {
        fail("invalid JSON fraction");
      }
    }
    if (position_ < input_.size() &&
        (input_[position_] == 'e' || input_[position_] == 'E')) {
      ++position_;
      if (position_ < input_.size() &&
          (input_[position_] == '+' || input_[position_] == '-')) {
        ++position_;
      }
      const std::size_t exponent_start = position_;
      while (position_ < input_.size() && input_[position_] >= '0' &&
             input_[position_] <= '9') {
        ++position_;
      }
      if (position_ == exponent_start) {
        fail("invalid JSON exponent");
      }
    }

    const std::string_view token = input_.substr(start, position_ - start);
    std::istringstream stream{std::string(token)};
    stream.imbue(std::locale::classic());
    double value = 0.0;
    if (!(stream >> std::noskipws >> value) ||
        stream.peek() != std::char_traits<char>::eof() ||
        !std::isfinite(value)) {
      fail("invalid finite JSON number");
    }
    return value;
  }

  void consume_literal(std::string_view literal) {
    if (input_.substr(position_, literal.size()) != literal) {
      fail("invalid JSON literal");
    }
    position_ += literal.size();
  }

  std::string_view input_;
  std::size_t position_ = 0;
};

[[nodiscard]] const JsonValue& required_field(const JsonValue::Object& object,
                                              std::string_view name) {
  const auto iterator = object.find(name);
  if (iterator == object.end()) {
    throw ProtocolError("INVALID_REQUEST",
                        "missing required field: " + std::string(name));
  }
  return iterator->second;
}

[[nodiscard]] const JsonValue::Object& required_object(
    const JsonValue::Object& object, std::string_view name) {
  const JsonValue::Object* value = required_field(object, name).object();
  if (value == nullptr) {
    throw ProtocolError("INVALID_REQUEST",
                        std::string(name) + " must be an object");
  }
  return *value;
}

[[nodiscard]] std::string required_string(const JsonValue::Object& object,
                                          std::string_view name) {
  const std::string* value = required_field(object, name).string();
  if (value == nullptr) {
    throw ProtocolError("INVALID_REQUEST",
                        std::string(name) + " must be a string");
  }
  return *value;
}

[[nodiscard]] double required_number(const JsonValue::Object& object,
                                     std::string_view name) {
  const double* value = required_field(object, name).number();
  if (value == nullptr || !std::isfinite(*value)) {
    throw ProtocolError("INVALID_REQUEST",
                        std::string(name) + " must be a finite number");
  }
  return *value;
}

void require_only_fields(const JsonValue::Object& object,
                         const std::vector<std::string_view>& allowed) {
  for (const auto& [key, value] : object) {
    static_cast<void>(value);
    if (std::find(allowed.begin(), allowed.end(), key) == allowed.end()) {
      throw ProtocolError("INVALID_REQUEST", "unknown field: " + key);
    }
  }
}

[[nodiscard]] int checked_integer(double value,
                                  int minimum,
                                  int maximum,
                                  std::string_view name) {
  if (std::floor(value) != value || value < static_cast<double>(minimum) ||
      value > static_cast<double>(maximum)) {
    throw ProtocolError(
        "INVALID_REQUEST",
        std::string(name) + " must be an integer in the supported range");
  }
  return static_cast<int>(value);
}

[[nodiscard]] std::int64_t checked_int64(double value,
                                         std::int64_t minimum,
                                         std::int64_t maximum,
                                         std::string_view name) {
  if (std::floor(value) != value || value < static_cast<double>(minimum) ||
      value > static_cast<double>(maximum)) {
    throw ProtocolError(
        "INVALID_REQUEST",
        std::string(name) + " must be an integer in the supported range");
  }
  return static_cast<std::int64_t>(value);
}

void validate_portable_mp4_path(const std::string& value) {
  if (value.empty() || value.size() > 512U || value.front() == '/' ||
      value.find('\\') != std::string::npos ||
      value.find('\0') != std::string::npos || value.find(':') != std::string::npos) {
    throw ProtocolError("INVALID_REQUEST",
                        "output.path must be a portable relative MP4 path");
  }
  std::size_t start = 0;
  while (start <= value.size()) {
    const std::size_t separator = value.find('/', start);
    const std::size_t end =
        separator == std::string::npos ? value.size() : separator;
    const std::string_view segment(value.data() + start, end - start);
    if (segment.empty() || segment == "." || segment == ".." ||
        segment.size() > 100U || segment.back() == '.' || segment.back() == ' ') {
      throw ProtocolError("INVALID_REQUEST",
                          "output.path must be a portable relative MP4 path");
    }
    for (const char raw_character : segment) {
      const unsigned char character =
          static_cast<unsigned char>(raw_character);
      const bool valid =
          (character >= 'A' && character <= 'Z') ||
          (character >= 'a' && character <= 'z') ||
          (character >= '0' && character <= '9') || character == '.' ||
          character == '_' || character == '-';
      if (!valid) {
        throw ProtocolError("INVALID_REQUEST",
                            "output.path must be a portable relative MP4 path");
      }
    }
    if (separator == std::string::npos) {
      break;
    }
    start = separator + 1U;
  }
  if (value.size() < 4U || value.substr(value.size() - 4U) != ".mp4") {
    throw ProtocolError("INVALID_REQUEST", "output.path must end in .mp4");
  }
}

[[nodiscard]] std::string json_escape(std::string_view value) {
  std::ostringstream output;
  for (const char raw_character : value) {
    const unsigned char character = static_cast<unsigned char>(raw_character);
    switch (character) {
      case '"':
        output << "\\\"";
        break;
      case '\\':
        output << "\\\\";
        break;
      case '\b':
        output << "\\b";
        break;
      case '\f':
        output << "\\f";
        break;
      case '\n':
        output << "\\n";
        break;
      case '\r':
        output << "\\r";
        break;
      case '\t':
        output << "\\t";
        break;
      default:
        if (character < 0x20U) {
          output << "\\u" << std::hex << std::setw(4) << std::setfill('0')
                 << static_cast<int>(character) << std::dec;
        } else {
          output << static_cast<char>(character);
        }
    }
  }
  return output.str();
}

void flush_event(std::ostream& output, const std::string& event) {
  output << event << '\n';
  output.flush();
  if (!output.good()) {
    throw std::runtime_error("failed to write sidecar protocol event");
  }
}

}  // namespace

ProtocolError::ProtocolError(std::string code, std::string message)
    : code_(std::move(code)), message_(std::move(message)) {}

const std::string& ProtocolError::code() const noexcept { return code_; }

const std::string& ProtocolError::message() const noexcept { return message_; }

EraseRequest read_request(std::istream& input) {
  std::string line;
  line.reserve(4096U);
  if (!std::getline(input, line)) {
    throw ProtocolError("INVALID_REQUEST", "missing JSON request line");
  }
  if (line.empty() || line.size() > kMaxRequestBytes) {
    throw ProtocolError("INVALID_REQUEST", "request exceeds the byte limit");
  }

  const JsonValue root_value = JsonParser(line).parse();
  const JsonValue::Object* root = root_value.object();
  if (root == nullptr) {
    throw ProtocolError("INVALID_REQUEST", "request root must be an object");
  }
  require_only_fields(*root,
                      {"protocolVersion", "operation", "input", "models",
                       "region", "output"});

  if (checked_integer(required_number(*root, "protocolVersion"), 0,
                      std::numeric_limits<int>::max(), "protocolVersion") !=
      kProtocolVersion) {
    throw ProtocolError("UNSUPPORTED_PROTOCOL", "unsupported protocol version");
  }
  if (required_string(*root, "operation") != "erase-hard-subtitles") {
    throw ProtocolError("UNSUPPORTED_OPERATION", "unsupported operation");
  }

  EraseRequest request;
  const JsonValue::Object& input_object = required_object(*root, "input");
  require_only_fields(input_object, {"path", "width", "height", "durationMs"});
  request.source_path = required_string(input_object, "path");
  request.input_width = checked_integer(required_number(input_object, "width"), 1,
                                        std::numeric_limits<int>::max(),
                                        "input.width");
  request.input_height = checked_integer(required_number(input_object, "height"), 1,
                                         std::numeric_limits<int>::max(),
                                         "input.height");
  request.duration_ms = checked_int64(
      required_number(input_object, "durationMs"), 0,
      9'007'199'254'740'991LL, "input.durationMs");
  if (request.source_path.empty() || request.source_path.size() > 4096U) {
    throw ProtocolError("INVALID_REQUEST", "input.path has an invalid length");
  }

  const JsonValue::Object& models = required_object(*root, "models");
  require_only_fields(models, {"detectorPath", "inpaintingPath"});
  request.detector_model_path = required_string(models, "detectorPath");
  request.inpainting_model_path = required_string(models, "inpaintingPath");
  if (request.detector_model_path.empty() ||
      request.detector_model_path.size() > 4096U ||
      request.inpainting_model_path.empty() ||
      request.inpainting_model_path.size() > 4096U) {
    throw ProtocolError("INVALID_REQUEST", "model path has an invalid length");
  }

  const JsonValue::Object& region = required_object(*root, "region");
  require_only_fields(region, {"x", "y", "width", "height"});
  request.search_region = {
      .x = checked_integer(required_number(region, "x"), 0,
                           std::numeric_limits<int>::max(), "region.x"),
      .y = checked_integer(required_number(region, "y"), 0,
                           std::numeric_limits<int>::max(), "region.y"),
      .width = checked_integer(required_number(region, "width"), 1,
                               std::numeric_limits<int>::max(), "region.width"),
      .height = checked_integer(required_number(region, "height"), 1,
                                std::numeric_limits<int>::max(), "region.height"),
  };
  const PixelRegion& pixels = request.search_region;
  if (static_cast<std::int64_t>(pixels.x) + pixels.width >
          request.input_width ||
      static_cast<std::int64_t>(pixels.y) + pixels.height >
          request.input_height) {
    throw ProtocolError("INVALID_REQUEST",
                        "region must stay inside the declared video frame");
  }

  const JsonValue::Object& output = required_object(*root, "output");
  require_only_fields(output, {"path"});
  request.output_relative_path = required_string(output, "path");
  validate_portable_mp4_path(request.output_relative_path);

  return request;
}

void emit_progress(std::ostream& output,
                   const std::string& stage,
                   double progress) {
  const double bounded = std::clamp(progress, 0.0, 1.0);
  std::ostringstream event;
  event << "{\"protocolVersion\":" << kProtocolVersion
        << ",\"type\":\"progress\",\"progress\":" << std::fixed
        << std::setprecision(4) << bounded << ",\"stage\":\""
        << json_escape(stage) << "\"}";
  flush_event(output, event.str());
}

void emit_result(std::ostream& output, const std::string& output_path) {
  flush_event(output,
              "{\"protocolVersion\":" + std::to_string(kProtocolVersion) +
                  ",\"type\":\"result\",\"outputPath\":\"" +
                  json_escape(output_path) + "\"}");
}

void emit_error(std::ostream& output, const std::string& message) {
  const std::string bounded_message = message.substr(0, 512U);
  flush_event(output,
              "{\"protocolVersion\":" + std::to_string(kProtocolVersion) +
                  ",\"type\":\"error\",\"message\":\"" +
                  json_escape(bounded_message) + "\"}");
}

}  // namespace convax::subtitle_erasure
