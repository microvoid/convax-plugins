import Darwin
import Foundation

final class TransformControl {
  private let lock = NSLock()
  private var cancelled = false
  private var process: Process?

  var isCancelled: Bool {
    lock.lock()
    defer { lock.unlock() }
    return cancelled
  }

  func attach(_ process: Process) {
    lock.lock()
    self.process = process
    let shouldCancel = cancelled
    lock.unlock()
    if shouldCancel { terminate(process) }
  }

  func detach(_ process: Process) {
    lock.lock()
    if self.process === process { self.process = nil }
    lock.unlock()
  }

  func cancel() {
    lock.lock()
    cancelled = true
    let running = process
    lock.unlock()
    if let running { terminate(running) }
  }

  private func terminate(_ process: Process) {
    guard process.isRunning else { return }
    process.terminate()
    let identifier = process.processIdentifier
    DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + .milliseconds(750)) {
      if process.isRunning { Darwin.kill(identifier, SIGKILL) }
    }
  }
}

struct GenerationArtifact {
  let mimeType: String
  let name: String
  let path: String

  var json: [String: Any] {
    ["mimeType": mimeType, "name": name, "path": path]
  }
}

final class FFmpegEngine {
  func generate(_ call: GenerationCall, control: TransformControl) throws -> [GenerationArtifact] {
    if control.isCancelled { throw CancellationError() }
    let references = try verifyReferences(call.references)
    let scope = try prepareOutputScope(directory: call.outputDirectory, outputName: call.outputName)
    var completed = false
    defer {
      if !completed {
        _ = scope.outputPath.withCString { Darwin.unlink($0) }
      }
    }
    let resolved = try resolveFFmpegArguments(
      call.argumentsJSON,
      references: references,
      outputPath: scope.outputPath
    )
    guard resolved.last == scope.outputPath else { throw ExecutionError() }
    let expectedMimeType = try mimeType(forOutputName: call.outputName, output: call.output)
    let lease = try EmbeddedFFmpegLease(outputDirectory: scope.directoryPath)
    defer { lease.dispose() }

    try references.forEach { try $0.assertStable() }
    try scope.inspect(requireCompleteOutput: false)
    if control.isCancelled { throw CancellationError() }

    let process = Process()
    process.executableURL = URL(fileURLWithPath: lease.path)
    process.arguments = [
      "-nostdin", "-hide_banner", "-y", "-protocol_whitelist", "file",
    ] + Array(resolved.dropLast()) + ["-fs", String(maximumArtifactBytes), scope.outputPath]
    process.currentDirectoryURL = URL(fileURLWithPath: scope.directoryPath, isDirectory: true)
    process.environment = ["LANG": "C", "LC_ALL": "C"]
    process.standardInput = FileHandle.nullDevice
    process.standardOutput = FileHandle.nullDevice
    process.standardError = FileHandle.nullDevice

    do {
      try process.run()
    } catch {
      throw ExecutionError()
    }
    control.attach(process)
    defer { control.detach(process) }

    var monitorFailure: Error?
    while process.isRunning {
      do {
        if control.isCancelled { throw CancellationError() }
        try references.forEach { try $0.assertStable() }
        try scope.inspect(requireCompleteOutput: false)
      } catch {
        monitorFailure = error
        control.cancel()
        break
      }
      Thread.sleep(forTimeInterval: 0.025)
    }
    process.waitUntilExit()
    if let monitorFailure { throw monitorFailure }
    if control.isCancelled { throw CancellationError() }
    guard process.terminationReason == .exit, process.terminationStatus == 0 else {
      throw ExecutionError()
    }
    try references.forEach { try $0.assertStable() }
    try scope.inspect(requireCompleteOutput: true)
    try validateOutputMedia(path: scope.outputPath, expectedMimeType: expectedMimeType)
    completed = true
    return [GenerationArtifact(mimeType: expectedMimeType, name: call.outputName, path: call.outputName)]
  }
}
