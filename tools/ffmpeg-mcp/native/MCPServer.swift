import CoreFoundation
import Darwin
import Foundation

private let maximumRequestBytes = 1024 * 1024

private struct RPCID: Hashable {
  let key: String
  let jsonValue: Any

  static func parse(_ value: Any?) -> RPCID? {
    if let string = value as? String {
      return RPCID(key: "s:\(string)", jsonValue: string)
    }
    if let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() {
      return RPCID(key: "n:\(number.stringValue)", jsonValue: number)
    }
    return nil
  }

  static func == (left: RPCID, right: RPCID) -> Bool { left.key == right.key }
  func hash(into hasher: inout Hasher) { hasher.combine(key) }
}

private final class JSONLineWriter {
  private let lock = NSLock()

  func send(_ value: [String: Any]) {
    guard JSONSerialization.isValidJSONObject(value),
          let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    else { return }
    lock.lock()
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([0x0a]))
    lock.unlock()
  }
}

final class MCPServer {
  private let engine = FFmpegEngine()
  private let writer = JSONLineWriter()
  private let inflightLock = NSLock()
  private var inflight: [RPCID: TransformControl] = [:]
  private let handlers = DispatchGroup()

  func run() {
    var buffer = Data()
    var overflow = false
    var readBuffer = [UInt8](repeating: 0, count: 64 * 1024)
    while true {
      let count = Darwin.read(STDIN_FILENO, &readBuffer, readBuffer.count)
      if count < 0, errno == EINTR { continue }
      if count <= 0 { break }
      for byte in readBuffer.prefix(count) {
        if byte == 0x0a {
          if overflow {
            sendError(id: nil, code: -32600, message: "Request exceeded the message size limit")
          } else {
            receive(buffer)
          }
          buffer.removeAll(keepingCapacity: true)
          overflow = false
        } else if !overflow {
          buffer.append(byte)
          if buffer.count > maximumRequestBytes {
            buffer.removeAll(keepingCapacity: false)
            overflow = true
          }
        }
      }
    }
    if overflow {
      sendError(id: nil, code: -32600, message: "Request exceeded the message size limit")
    } else if !buffer.isEmpty {
      receive(buffer)
    }
    cancelAll()
    handlers.wait()
  }

  private func receive(_ data: Data) {
    guard let text = String(data: data, encoding: .utf8) else {
      sendError(id: nil, code: -32700, message: "Parse error")
      return
    }
    if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return }
    let value: Any
    do {
      value = try JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])
    } catch {
      sendError(id: nil, code: -32700, message: "Parse error")
      return
    }
    guard let request = value as? [String: Any],
          request["jsonrpc"] as? String == "2.0",
          let method = request["method"] as? String
    else {
      sendError(id: nil, code: -32600, message: "Invalid Request")
      return
    }
    let rawID = request["id"]
    let hasID = rawID != nil && !(rawID is NSNull)
    let id = hasID ? RPCID.parse(rawID) : nil
    if hasID && id == nil {
      sendError(id: nil, code: -32600, message: "Invalid Request")
      return
    }

    if method == "notifications/initialized" { return }
    if method == "notifications/cancelled" || method == "$/cancelRequest" {
      cancel(request["params"])
      return
    }
    guard let id else { return }
    switch method {
    case "initialize": initialize(id: id, params: request["params"])
    case "tools/list": sendResult(id: id, result: ["tools": generationTools.map(\.json)])
    case "tools/call": callTool(id: id, params: request["params"])
    case "cancel":
      cancel(request["params"])
      sendResult(id: id, result: [:])
    default: sendError(id: id, code: -32601, message: "Method not found")
    }
  }

  private func initialize(id: RPCID, params: Any?) {
    do {
      let object = try requireObject(params, "initialize params")
      guard object["protocolVersion"] as? String == protocolVersion else {
        sendError(id: id, code: -32602, message: "Unsupported MCP protocol version")
        return
      }
      sendResult(id: id, result: [
        "capabilities": ["tools": [:]],
        "protocolVersion": protocolVersion,
        "serverInfo": ["name": "convax-ffmpeg-mcp", "version": "0.2.0"],
      ])
    } catch {
      sendError(id: id, code: -32602, message: "Invalid initialize params")
    }
  }

  private func callTool(id: RPCID, params: Any?) {
    let object: [String: Any]
    let selected: ToolDefinition
    do {
      object = try requireObject(params, "tools/call params")
      guard let name = object["name"] as? String,
            let tool = generationTools.first(where: { $0.name == name })
      else {
        sendError(id: id, code: -32602, message: "Unknown tool")
        return
      }
      selected = tool
    } catch {
      sendError(id: id, code: -32602, message: "Invalid tools/call params")
      return
    }

    let control = TransformControl()
    inflightLock.lock()
    if inflight[id] != nil {
      inflightLock.unlock()
      sendError(id: id, code: -32600, message: "Duplicate request id")
      return
    }
    inflight[id] = control
    inflightLock.unlock()
    handlers.enter()
    DispatchQueue.global(qos: .userInitiated).async { [self] in
      defer {
        inflightLock.lock()
        inflight.removeValue(forKey: id)
        inflightLock.unlock()
        handlers.leave()
      }
      do {
        let call = try parseToolCall(object["arguments"], tool: selected)
        let artifacts = try engine.generate(call, control: control)
        sendResult(id: id, result: [
          "content": [[
            "text": "Created \(artifacts.count) local FFmpeg artifact\(artifacts.count == 1 ? "" : "s").",
            "type": "text",
          ]],
          "structuredContent": [
            "artifacts": artifacts.map(\.json),
            "schema": generationResultSchema,
          ],
        ])
      } catch let error as PublicInputError {
        sendToolFailure(id: id, message: error.message)
      } catch is CancellationError {
        FileHandle.standardError.write(Data("[ffmpeg] transform cancelled\n".utf8))
        sendToolFailure(id: id, message: "FFmpeg transform was cancelled.")
      } catch {
        FileHandle.standardError.write(Data("[ffmpeg] transform failed\n".utf8))
        sendToolFailure(id: id, message: "FFmpeg transform failed.")
      }
    }
  }

  private func cancel(_ params: Any?) {
    guard let object = params as? [String: Any], let id = RPCID.parse(object["requestId"]) else { return }
    inflightLock.lock()
    let control = inflight[id]
    inflightLock.unlock()
    control?.cancel()
  }

  private func cancelAll() {
    inflightLock.lock()
    let controls = Array(inflight.values)
    inflightLock.unlock()
    controls.forEach { $0.cancel() }
  }

  private func sendToolFailure(id: RPCID, message: String) {
    sendResult(id: id, result: [
      "content": [["text": message, "type": "text"]],
      "isError": true,
    ])
  }

  private func sendResult(id: RPCID, result: Any) {
    writer.send(["id": id.jsonValue, "jsonrpc": "2.0", "result": result])
  }

  private func sendError(id: RPCID?, code: Int, message: String) {
    writer.send([
      "error": ["code": code, "message": message],
      "id": id?.jsonValue ?? NSNull(),
      "jsonrpc": "2.0",
    ])
  }
}
