import Foundation

let protocolVersion = "2025-03-26"
let generationCallSchema = "convax.generation-call/1"
let generationResultSchema = "convax.generation-result/1"
let maximumArtifactBytes: Int64 = 2 * 1024 * 1024 * 1024

struct PublicInputError: Error {
  let message: String
}

struct ExecutionError: Error {}

struct CancellationError: Error {}

enum OutputKind: String {
  case image
  case video
  case audio
}

struct GenerationReference {
  let mimeType: String
  let name: String
  let nodeID: String
  let path: String
  let role: String
}

struct GenerationCall {
  let argumentsJSON: String
  let operationID: String
  let output: OutputKind
  let outputDirectory: String
  let outputName: String
  let prompt: String
  let references: [GenerationReference]
}

struct ToolDefinition {
  let name: String
  let output: OutputKind
  let description: String

  var json: [String: Any] {
    let common: [String: Any] = [
      "arguments_json": [
        "description": "JSON array of FFmpeg argv strings. Use exact {{input:N}} and {{output}} path placeholders; do not include ffmpeg itself or shell quoting.",
        "maxLength": 4_096,
        "minLength": 2,
        "title": "FFmpeg arguments (JSON)",
        "type": "string",
      ],
      "operation_id": ["maxLength": 256, "minLength": 1, "type": "string"],
      "output_directory": ["maxLength": 4_096, "minLength": 1, "type": "string"],
      "output_name": [
        "description": "Portable output basename with an extension compatible with the selected tool.",
        "maxLength": 128,
        "minLength": 3,
        "title": "Output file name",
        "type": "string",
      ],
      "prompt": ["maxLength": 20_000, "minLength": 1, "type": "string"],
      "references": ["items": ["type": "object"], "maxItems": 16, "type": "array"],
      "schema": ["const": generationCallSchema, "type": "string"],
      "output": ["const": output.rawValue, "type": "string"],
    ]
    return [
      "description": description,
      "inputSchema": [
        "additionalProperties": false,
        "properties": common,
        "required": [
          "schema", "operation_id", "prompt", "output", "output_directory", "references",
          "arguments_json", "output_name",
        ],
        "type": "object",
      ],
      "name": name,
    ]
  }
}

let generationTools = [
  ToolDefinition(name: "run.image", output: .image, description: "Run scoped FFmpeg argv and return one image artifact."),
  ToolDefinition(name: "run.video", output: .video, description: "Run scoped FFmpeg argv and return one video artifact."),
  ToolDefinition(name: "run.audio", output: .audio, description: "Run scoped FFmpeg argv and return one audio artifact."),
]

private let allowedReferenceRoles = Set([
  "reference_image", "reference_video", "first_frame", "last_frame", "audio",
])

private let outputMimeTypes: [OutputKind: [String: String]] = [
  .image: [
    "gif": "image/gif", "jpeg": "image/jpeg", "jpg": "image/jpeg", "png": "image/png",
    "webp": "image/webp",
  ],
  .video: ["mov": "video/quicktime", "mp4": "video/mp4", "webm": "video/webm"],
  .audio: [
    "flac": "audio/flac", "m4a": "audio/mp4", "mp3": "audio/mpeg", "ogg": "audio/ogg",
    "wav": "audio/wav",
  ],
]

func mimeType(forOutputName name: String, output: OutputKind) throws -> String {
  let extensionName = (name as NSString).pathExtension.lowercased()
  guard let mime = outputMimeTypes[output]?[extensionName] else {
    throw PublicInputError(message: "output_name extension is not supported for \(output.rawValue) output.")
  }
  return mime
}

func normalizeMimeType(_ value: String) -> String {
  value.split(separator: ";", maxSplits: 1, omittingEmptySubsequences: false)[0]
    .trimmingCharacters(in: .whitespacesAndNewlines)
    .lowercased()
}

func compatibleMimeTypes(_ left: String, _ right: String) -> Bool {
  if left == right { return true }
  return Set([left, right]) == Set(["audio/wav", "audio/x-wav"])
}

func requireObject(_ value: Any?, _ label: String) throws -> [String: Any] {
  guard let object = value as? [String: Any] else {
    throw PublicInputError(message: "\(label) must be an object.")
  }
  return object
}

private func requireExactKeys(_ object: [String: Any], _ keys: Set<String>, _ label: String) throws {
  guard Set(object.keys) == keys else {
    throw PublicInputError(message: "\(label) contains unsupported fields.")
  }
}

private func requiredString(_ value: Any?, _ label: String, _ maximumLength: Int) throws -> String {
  guard let string = value as? String,
        !string.isEmpty,
        string.count <= maximumLength,
        string == string.trimmingCharacters(in: .whitespacesAndNewlines),
        !string.unicodeScalars.contains(where: { $0.value <= 0x1f || $0.value == 0x7f })
  else {
    throw PublicInputError(message: "\(label) must be a non-empty trimmed string.")
  }
  return string
}

private func portableOutputName(_ value: Any?, output: OutputKind) throws -> String {
  let name = try requiredString(value, "output_name", 128)
  guard name.range(of: "^[A-Za-z0-9][A-Za-z0-9._-]*$", options: .regularExpression) != nil,
        name != ".", name != "..",
        !(name as NSString).deletingPathExtension.isEmpty
  else {
    throw PublicInputError(message: "output_name must be a portable file basename.")
  }
  let stem = (name as NSString).deletingPathExtension.uppercased()
  let reserved = Set(["CON", "PRN", "AUX", "NUL"] +
    (1...9).flatMap { ["COM\($0)", "LPT\($0)"] })
  guard !reserved.contains(stem), !name.hasSuffix("."), !name.hasSuffix(" ") else {
    throw PublicInputError(message: "output_name must be a portable file basename.")
  }
  _ = try mimeType(forOutputName: name, output: output)
  return name
}

func parseGenerationCall(_ value: Any?, expectedOutput: OutputKind) throws -> GenerationCall {
  let input = try requireObject(value, "generation call")
  try requireExactKeys(input, Set([
    "arguments_json", "operation_id", "output", "output_directory", "output_name", "prompt",
    "references", "schema",
  ]), "generation call")
  guard input["schema"] as? String == generationCallSchema else {
    throw PublicInputError(message: "generation call schema is not supported.")
  }
  guard input["output"] as? String == expectedOutput.rawValue else {
    throw PublicInputError(message: "generation call output does not match the selected tool.")
  }
  guard let referenceValues = input["references"] as? [Any], referenceValues.count <= 16 else {
    throw PublicInputError(message: "generation references must contain at most 16 files.")
  }
  let references = try referenceValues.enumerated().map { index, value -> GenerationReference in
    let reference = try requireObject(value, "generation reference \(index)")
    try requireExactKeys(reference, Set(["kind", "mime_type", "name", "node_id", "path", "role"]), "generation reference \(index)")
    guard reference["kind"] as? String == "file" else {
      throw PublicInputError(message: "generation reference \(index) must be a staged file.")
    }
    guard let role = reference["role"] as? String, allowedReferenceRoles.contains(role) else {
      throw PublicInputError(message: "generation reference \(index) has an unsupported role.")
    }
    return GenerationReference(
      mimeType: try requiredString(reference["mime_type"], "generation reference \(index) mime_type", 256),
      name: try requiredString(reference["name"], "generation reference \(index) name", 512),
      nodeID: try requiredString(reference["node_id"], "generation reference \(index) node_id", 256),
      path: try requiredString(reference["path"], "generation reference \(index) path", 4_096),
      role: role
    )
  }
  let outputName = try portableOutputName(input["output_name"], output: expectedOutput)
  return GenerationCall(
    argumentsJSON: try requiredString(input["arguments_json"], "arguments_json", 4_096),
    operationID: try requiredString(input["operation_id"], "operation_id", 256),
    output: expectedOutput,
    outputDirectory: try requiredString(input["output_directory"], "output_directory", 4_096),
    outputName: outputName,
    prompt: try requiredString(input["prompt"], "prompt", 20_000),
    references: references
  )
}
