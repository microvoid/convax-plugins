import CryptoKit
import Darwin
import Foundation

private let maximumEmbeddedBinaryBytes = 128 * 1024 * 1024

private func sha256(_ data: Data) -> String {
  SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
}

private func isInside(_ child: String, parent: String) -> Bool {
  child == parent || child.hasPrefix(parent.hasSuffix("/") ? parent : parent + "/")
}

private func writeExecutable(_ data: Data, path: String) throws {
  let descriptor = path.withCString {
    Darwin.open($0, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW, S_IRUSR | S_IWUSR | S_IXUSR)
  }
  guard descriptor >= 0 else { throw ExecutionError() }
  var failure: Error?
  data.withUnsafeBytes { bytes in
    var offset = 0
    while offset < bytes.count {
      let count = Darwin.write(descriptor, bytes.baseAddress!.advanced(by: offset), bytes.count - offset)
      if count <= 0 {
        failure = ExecutionError()
        return
      }
      offset += count
    }
  }
  if failure == nil, fchmod(descriptor, S_IRUSR | S_IXUSR) != 0 { failure = ExecutionError() }
  if failure == nil, fsync(descriptor) != 0 { failure = ExecutionError() }
  if Darwin.close(descriptor) != 0, failure == nil { failure = ExecutionError() }
  if let failure { throw failure }
}

final class EmbeddedFFmpegLease {
  let path: String
  private let directory: String
  private let lock = NSLock()
  private var disposed = false

  init(outputDirectory: String) throws {
    var binarySize = 0
    var hashSize = 0
    guard let binaryPointer = convax_embedded_ffmpeg(&binarySize),
          let hashPointer = convax_embedded_ffmpeg_sha256(&hashSize),
          binarySize > 0,
          binarySize <= maximumEmbeddedBinaryBytes,
          hashSize == 64
    else { throw ExecutionError() }
    let binary = Data(bytes: binaryPointer, count: binarySize)
    let expectedHash = String(decoding: UnsafeBufferPointer(start: hashPointer, count: hashSize), as: UTF8.self)
    guard expectedHash.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil,
          sha256(binary) == expectedHash
    else { throw ExecutionError() }

    let output = URL(fileURLWithPath: outputDirectory).standardizedFileURL.path
    let candidates = [
      FileManager.default.temporaryDirectory.path,
      FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first?.path,
    ].compactMap { $0 }
    var selectedDirectory: String?
    for base in candidates {
      let canonicalBase = URL(fileURLWithPath: base).resolvingSymlinksInPath().path
      if isInside(canonicalBase, parent: output) { continue }
      let candidate = (canonicalBase as NSString).appendingPathComponent(".convax-ffmpeg-runtime-\(UUID().uuidString)")
      do {
        try FileManager.default.createDirectory(
          atPath: candidate,
          withIntermediateDirectories: false,
          attributes: [.posixPermissions: 0o700]
        )
        let canonicalCandidate = URL(fileURLWithPath: candidate).resolvingSymlinksInPath().path
        guard !isInside(canonicalCandidate, parent: output) else {
          try? FileManager.default.removeItem(atPath: candidate)
          continue
        }
        selectedDirectory = canonicalCandidate
        break
      } catch {
        continue
      }
    }
    guard let runtimeDirectory = selectedDirectory else { throw ExecutionError() }
    directory = runtimeDirectory
    path = (runtimeDirectory as NSString).appendingPathComponent("ffmpeg")
    do {
      try writeExecutable(binary, path: path)
      let materialized = try Data(contentsOf: URL(fileURLWithPath: path), options: [.mappedIfSafe])
      guard materialized.count == binary.count, sha256(materialized) == expectedHash else { throw ExecutionError() }
    } catch {
      try? FileManager.default.removeItem(atPath: runtimeDirectory)
      throw error
    }
  }

  func dispose() {
    lock.lock()
    if disposed {
      lock.unlock()
      return
    }
    disposed = true
    lock.unlock()
    try? FileManager.default.removeItem(atPath: directory)
  }

  deinit {
    dispose()
  }
}
