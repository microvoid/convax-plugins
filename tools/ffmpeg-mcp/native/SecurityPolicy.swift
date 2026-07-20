import Darwin
import Foundation

private let maximumArguments = 256
private let maximumArgumentLength = 1_024
private let inputPlaceholderPattern = "^\\{\\{input:(0|[1-9][0-9]*)\\}\\}$"
private let outputPlaceholder = "{{output}}"

private let pathOpeningOptions = Set([
  "-apre", "-attach", "-dump_attachment", "-enable_drefs", "-filter_complex_script", "-filter_script",
  "-fpre", "-fs", "-pass", "-passlogfile", "-pre", "-progress", "-protocol_whitelist", "-report",
  "-sdp_file", "-spre", "-stats_enc_post", "-stats_enc_pre", "-stats_mux_pre", "-use_absolute_path",
  "-vpre", "-vstats_file",
])

private let filterExpressionOptions = Set(["-af", "-filter", "-filter_complex", "-lavfi", "-vf"])
private let opaqueValueOptions = Set(["-metadata"])
private let pathOpeningFilter = "(?:^|[^A-Za-z0-9_])(?:a?movie|arnndn|ass|fsync|subtitles|a?sendcmd|azmq|zmq|frei0r|ladspa|libplacebo|lut1d|lut3d|lv2|ocr|openclsrc|removelogo|signature|sofalizer|vidstabdetect|vidstabtransform|whisper)\\s*=|(?:^|[=,:])(?:dumpfile|file|filename|fontfile|model|model_path|shader|shader_path|textfile)\\s*="
private let explicitProtocol = "(?:^|[=,;])(?:https?|ftp|async|cache|fd|file|concat|concatf|crypto|data|gopher|hls|icecast|md5|mmsh|mmst|pipe|prompeg|rtmp|rtmps|rtp|sftp|smb|subfile|tcp|tee|tls|udp):"
private let likelyRelativeFile = "^[^/\\\\]+\\.[A-Za-z][A-Za-z0-9]{0,9}$"
private let expressionAtom = "(?:[0-9]+(?:\\.[0-9]+)?|iw|ih|ow|oh|in_w|in_h|out_w|out_h|sar|dar|hsub|vsub|n|t|pos)"
private let safeDivision = "\(expressionAtom)\\s*/\\s*\(expressionAtom)"

private func matches(_ value: String, _ pattern: String, caseInsensitive: Bool = false) -> Bool {
  var options: String.CompareOptions = .regularExpression
  if caseInsensitive { options.insert(.caseInsensitive) }
  return value.range(of: pattern, options: options) != nil
}

private func optionBase(_ token: String) -> String {
  guard let colon = token.firstIndex(of: ":") else { return token }
  return String(token[..<colon])
}

private func rejectAmbientOperand(_ token: String) throws {
  if token == "-" {
    throw PublicInputError(message: "FFmpeg pipe operands are not allowed.")
  }
  if (token as NSString).isAbsolutePath || matches(token, "^[A-Za-z]:[\\\\/]") {
    throw PublicInputError(message: "FFmpeg arguments cannot contain absolute paths.")
  }
  if token.split(whereSeparator: { $0 == "/" || $0 == "\\" }).contains("..") {
    throw PublicInputError(message: "FFmpeg arguments cannot contain traversal paths.")
  }
  if token.contains("\\") {
    throw PublicInputError(message: "FFmpeg arguments cannot contain native path separators.")
  }
  if matches(token, explicitProtocol, caseInsensitive: true) || token.contains("://") {
    throw PublicInputError(message: "FFmpeg arguments cannot contain network or file URLs.")
  }
  if matches(token, pathOpeningFilter, caseInsensitive: true) {
    throw PublicInputError(message: "This FFmpeg filter can open files outside the staged inputs.")
  }
  let withoutDivision = token.replacingOccurrences(
    of: safeDivision,
    with: "",
    options: .regularExpression
  )
  if withoutDivision.contains("/") {
    throw PublicInputError(message: "FFmpeg arguments cannot contain relative path operands.")
  }
  if matches(token, likelyRelativeFile), !matches(token, "^[-+]?\\d+(?:\\.\\d+)?$") {
    throw PublicInputError(message: "FFmpeg file operands must use an exact host placeholder.")
  }
}

private func rejectFilterExpression(_ token: String) throws {
  if matches(token, pathOpeningFilter, caseInsensitive: true) {
    throw PublicInputError(message: "This FFmpeg filter can open files outside the staged inputs.")
  }
  if matches(token, explicitProtocol, caseInsensitive: true) || token.contains("://") {
    throw PublicInputError(message: "FFmpeg filter expressions cannot contain network or file URLs.")
  }
  if token.split(whereSeparator: { $0 == "/" || $0 == "\\" }).contains("..") || token.contains("\\") {
    throw PublicInputError(message: "FFmpeg filter expressions cannot contain native or traversal paths.")
  }
}

private func exactValueOperand(_ tokens: [String], index: Int, option: String) throws -> String {
  guard index + 1 < tokens.count else {
    throw PublicInputError(message: "FFmpeg option \(option) requires a value.")
  }
  let operand = tokens[index + 1]
  if operand == outputPlaceholder || matches(operand, inputPlaceholderPattern)
    || operand.contains("{{input:") || operand.contains(outputPlaceholder)
  {
    throw PublicInputError(message: "FFmpeg placeholders cannot be used inside metadata or filter expressions.")
  }
  return operand
}

func resolveFFmpegArguments(
  _ argumentsJSON: String,
  references: [VerifiedReference],
  outputPath: String
) throws -> [String] {
  let value: Any
  do {
    value = try JSONSerialization.jsonObject(with: Data(argumentsJSON.utf8), options: [.fragmentsAllowed])
  } catch {
    throw PublicInputError(message: "arguments_json must be a JSON array of FFmpeg argv strings.")
  }
  guard let values = value as? [Any], !values.isEmpty, values.count <= maximumArguments else {
    throw PublicInputError(message: "arguments_json must contain 1 to \(maximumArguments) argv strings.")
  }
  let tokens = try values.enumerated().map { index, value -> String in
    guard let token = value as? String,
          !token.isEmpty,
          token.count <= maximumArgumentLength,
          !token.unicodeScalars.contains(where: { $0.value <= 0x1f || $0.value == 0x7f })
    else {
      throw PublicInputError(message: "FFmpeg argument \(index) is invalid.")
    }
    return token
  }
  guard tokens.last == outputPlaceholder else {
    throw PublicInputError(message: "The final FFmpeg argument must be the exact {{output}} placeholder.")
  }
  guard tokens.filter({ $0 == outputPlaceholder }).count == 1 else {
    throw PublicInputError(message: "FFmpeg arguments must contain exactly one {{output}} placeholder.")
  }

  var index = 0
  while index < tokens.count {
    let token = tokens[index]
    let base = optionBase(token)
    if pathOpeningOptions.contains(base) {
      throw PublicInputError(message: "FFmpeg option \(base) is not allowed by the scoped execution policy.")
    }
    if base == "-i" {
      guard index + 1 < tokens.count, matches(tokens[index + 1], inputPlaceholderPattern) else {
        throw PublicInputError(message: "Every FFmpeg -i operand must be an exact {{input:N}} placeholder.")
      }
      index += 2
      continue
    }
    if opaqueValueOptions.contains(base) {
      _ = try exactValueOperand(tokens, index: index, option: base)
      index += 2
      continue
    }
    if filterExpressionOptions.contains(base) {
      try rejectFilterExpression(exactValueOperand(tokens, index: index, option: base))
      index += 2
      continue
    }
    if token == outputPlaceholder || matches(token, inputPlaceholderPattern) {
      index += 1
      continue
    }
    if token.contains("{{input:") || token.contains(outputPlaceholder) {
      throw PublicInputError(message: "FFmpeg placeholders must occupy a complete argv token.")
    }
    try rejectAmbientOperand(token)
    index += 1
  }

  return try tokens.map { token in
    if token == outputPlaceholder { return outputPath }
    guard matches(token, inputPlaceholderPattern) else { return token }
    let start = token.index(token.startIndex, offsetBy: "{{input:".count)
    let end = token.index(token.endIndex, offsetBy: -2)
    guard let referenceIndex = Int(token[start..<end]), references.indices.contains(referenceIndex) else {
      throw PublicInputError(message: "FFmpeg input placeholder has no matching Canvas reference.")
    }
    return references[referenceIndex].path
  }
}

struct FileIdentity: Equatable {
  let device: dev_t
  let inode: ino_t
  let mode: mode_t
  let size: off_t
  let modifiedSeconds: Int
  let modifiedNanoseconds: Int

  init(_ value: stat) {
    device = value.st_dev
    inode = value.st_ino
    mode = value.st_mode
    size = value.st_size
    modifiedSeconds = value.st_mtimespec.tv_sec
    modifiedNanoseconds = value.st_mtimespec.tv_nsec
  }

  var isRegularFile: Bool { mode & S_IFMT == S_IFREG }
  var isDirectory: Bool { mode & S_IFMT == S_IFDIR }
  var isSymbolicLink: Bool { mode & S_IFMT == S_IFLNK }
}

private func status(at path: String) throws -> FileIdentity {
  var value = stat()
  let result = path.withCString { pointer in Darwin.lstat(pointer, &value) }
  guard result == 0 else { throw ExecutionError() }
  return FileIdentity(value)
}

private func canonicalPath(_ path: String) throws -> String {
  guard let pointer = realpath(path, nil) else { throw ExecutionError() }
  defer { free(pointer) }
  return String(cString: pointer)
}

func sniffMimeType(_ header: [UInt8]) -> String? {
  func ascii(_ offset: Int, _ length: Int) -> String? {
    guard header.count >= offset + length else { return nil }
    return String(bytes: header[offset..<(offset + length)], encoding: .ascii)
  }
  if header.starts(with: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) { return "image/png" }
  if header.count >= 3, header[0] == 0xff, header[1] == 0xd8, header[2] == 0xff { return "image/jpeg" }
  if ascii(0, 6) == "GIF87a" || ascii(0, 6) == "GIF89a" { return "image/gif" }
  if ascii(0, 4) == "RIFF", ascii(8, 4) == "WEBP" { return "image/webp" }
  if header.starts(with: [0x1a, 0x45, 0xdf, 0xa3]) { return "video/webm" }
  if ascii(4, 4) == "ftyp" {
    let brand = ascii(8, 4)
    if brand == "M4A " || brand == "M4B " { return "audio/mp4" }
    return brand == "qt  " ? "video/quicktime" : "video/mp4"
  }
  if ascii(0, 4) == "OggS" { return "audio/ogg" }
  if ascii(0, 4) == "fLaC" { return "audio/flac" }
  if ascii(0, 4) == "RIFF", ascii(8, 4) == "WAVE" { return "audio/wav" }
  if ascii(0, 3) == "ID3" || (header.count >= 2 && header[0] == 0xff && header[1] & 0xe0 == 0xe0) {
    return "audio/mpeg"
  }
  return nil
}

private func stableHeader(path: String, maximumBytes: Int = 32) throws -> ([UInt8], FileIdentity) {
  let descriptor = path.withCString { Darwin.open($0, O_RDONLY | O_NOFOLLOW | O_CLOEXEC) }
  guard descriptor >= 0 else { throw PublicInputError(message: "A staged FFmpeg input is not a readable regular file.") }
  defer { Darwin.close(descriptor) }
  var before = stat()
  guard fstat(descriptor, &before) == 0 else { throw ExecutionError() }
  let identity = FileIdentity(before)
  guard identity.isRegularFile, identity.size > 0, identity.size <= maximumArtifactBytes else {
    throw PublicInputError(message: "A staged FFmpeg input is not a supported regular media file.")
  }
  var bytes = [UInt8](repeating: 0, count: min(maximumBytes, Int(identity.size)))
  let count = bytes.withUnsafeMutableBytes { pointer in
    pread(descriptor, pointer.baseAddress, pointer.count, 0)
  }
  guard count == bytes.count else { throw ExecutionError() }
  var after = stat()
  guard fstat(descriptor, &after) == 0, FileIdentity(after) == identity else { throw ExecutionError() }
  return (bytes, identity)
}

struct VerifiedReference {
  let path: String
  private let identity: FileIdentity

  init(path: String, identity: FileIdentity) {
    self.path = path
    self.identity = identity
  }

  func assertStable() throws {
    guard try status(at: path) == identity else { throw ExecutionError() }
  }
}

func verifyReferences(_ references: [GenerationReference]) throws -> [VerifiedReference] {
  try references.enumerated().map { index, reference in
    guard (reference.path as NSString).isAbsolutePath,
          !reference.path.contains("%"),
          !reference.path.contains("*"),
          !reference.path.contains("?"),
          !reference.path.contains("[")
    else {
      throw PublicInputError(message: "generation reference \(index) path is not a safe staged file path.")
    }
    let unresolvedIdentity = try status(at: reference.path)
    guard unresolvedIdentity.isRegularFile, !unresolvedIdentity.isSymbolicLink else {
      throw PublicInputError(message: "generation reference \(index) must be a non-symbolic regular file.")
    }
    let path = try canonicalPath(reference.path)
    let (header, identity) = try stableHeader(path: path)
    guard identity.device == unresolvedIdentity.device, identity.inode == unresolvedIdentity.inode else {
      throw PublicInputError(message: "generation reference \(index) changed during validation.")
    }
    guard let detected = sniffMimeType(header) else {
      throw PublicInputError(message: "generation reference \(index) is not supported media.")
    }
    let claimed = normalizeMimeType(reference.mimeType)
    guard compatibleMimeTypes(claimed, detected) else {
      throw PublicInputError(message: "generation reference \(index) MIME type does not match its content.")
    }
    let expectedPrefix: String
    switch reference.role {
    case "reference_image", "first_frame", "last_frame": expectedPrefix = "image/"
    case "reference_video": expectedPrefix = "video/"
    case "audio": expectedPrefix = "audio/"
    default: throw PublicInputError(message: "generation reference \(index) has an unsupported role.")
    }
    guard detected.hasPrefix(expectedPrefix) else {
      throw PublicInputError(message: "generation reference \(index) role does not match its content.")
    }
    return VerifiedReference(path: path, identity: identity)
  }
}

struct OutputScope {
  let directoryPath: String
  let directoryIdentity: DirectoryIdentity
  let outputName: String
  let outputPath: String

  func inspect(requireCompleteOutput: Bool) throws {
    guard DirectoryIdentity(try status(at: directoryPath)) == directoryIdentity else { throw ExecutionError() }
    let entries = try FileManager.default.contentsOfDirectory(atPath: directoryPath)
    if requireCompleteOutput {
      guard entries == [outputName] || Set(entries) == Set([outputName]) else { throw ExecutionError() }
    } else {
      guard entries.isEmpty || Set(entries) == Set([outputName]) else { throw ExecutionError() }
    }
    if entries.contains(outputName) {
      guard try status(at: outputPath).isRegularFile else { throw ExecutionError() }
    }
    if entries.contains(outputName) {
      let output = try status(at: outputPath)
      guard !output.isSymbolicLink, output.size >= 0, output.size < maximumArtifactBytes,
            !requireCompleteOutput || output.size > 0
      else { throw ExecutionError() }
    }
  }
}

struct DirectoryIdentity: Equatable {
  let device: dev_t
  let inode: ino_t
  let mode: mode_t

  init(_ value: FileIdentity) {
    device = value.device
    inode = value.inode
    mode = value.mode
  }
}

func prepareOutputScope(directory: String, outputName: String) throws -> OutputScope {
  guard (directory as NSString).isAbsolutePath else {
    throw PublicInputError(message: "output_directory must be an absolute host directory.")
  }
  let identity = try status(at: directory)
  guard identity.isDirectory, !identity.isSymbolicLink else { throw ExecutionError() }
  let canonical = try canonicalPath(directory)
  guard FileManager.default.fileExists(atPath: canonical) else { throw ExecutionError() }
  guard try FileManager.default.contentsOfDirectory(atPath: canonical).isEmpty else {
    throw PublicInputError(message: "output_directory must be empty before an FFmpeg transform.")
  }
  let outputPath = (canonical as NSString).appendingPathComponent(outputName)
  let scope = OutputScope(
    directoryPath: canonical,
    directoryIdentity: DirectoryIdentity(try status(at: canonical)),
    outputName: outputName,
    outputPath: outputPath
  )
  try scope.inspect(requireCompleteOutput: false)
  return scope
}

func validateOutputMedia(path: String, expectedMimeType: String) throws {
  let (header, _) = try stableHeader(path: path)
  guard let detected = sniffMimeType(header), compatibleMimeTypes(detected, expectedMimeType) else {
    throw ExecutionError()
  }
}
