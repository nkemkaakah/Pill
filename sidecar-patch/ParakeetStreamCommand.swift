import AVFoundation
import CoreML
import FluidAudio
import Foundation

/// Continuous streaming ASR over stdin, for host apps that want live transcription.
///
/// `parakeet-eou` is file-in/blob-out: it reads a whole AVAudioFile into one buffer and
/// prints once, so a host has to re-spawn per utterance and pay model load every time.
/// This command keeps one process alive, consumes raw PCM from stdin, and emits NDJSON
/// as speech is recognised.
///
///   stdin   raw PCM, signed 16-bit little-endian, 16 kHz, mono
///   stdout  one JSON object per line:
///             {"type":"ready"}
///             {"type":"partial","text":"..."}   revisable, fires as tokens decode
///             {"type":"final","text":"..."}     an utterance closed by end-of-utterance
///             {"type":"error","message":"..."}
///   stderr  plain-text diagnostics
///
/// Diagnostics deliberately bypass AppLogger: it routes to OSLog and mirrors to the
/// console only in DEBUG builds, so in a release binary a spawned child sees nothing at
/// all — not even --help. A host process must be able to see why this failed.
struct ParakeetStreamCommand {

    private static let stderrHandle = FileHandle.standardError

    static func log(_ message: String) {
        if let data = "[parakeet-stream] \(message)\n".data(using: .utf8) {
            stderrHandle.write(data)
        }
    }

    static func emit(_ object: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: object, options: []),
            var line = String(data: data, encoding: .utf8)
        else { return }
        line += "\n"
        FileHandle.standardOutput.write(line.data(using: .utf8)!)
    }

    /// Callbacks are @Sendable and fire from inside the actor, so they only park state
    /// here. Touching the manager from within them would re-enter it.
    final class Box: @unchecked Sendable {
        private let lock = NSLock()
        private var _partial: String = ""
        private var _finals: [String] = []

        func setPartial(_ text: String) {
            lock.lock(); defer { lock.unlock() }
            _partial = text
        }
        func pushFinal(_ text: String) {
            lock.lock(); defer { lock.unlock() }
            _finals.append(text)
        }
        func drainFinals() -> [String] {
            lock.lock(); defer { lock.unlock() }
            let out = _finals
            _finals.removeAll()
            return out
        }
        func takePartial() -> String {
            lock.lock(); defer { lock.unlock() }
            return _partial
        }
        func clearPartial() {
            lock.lock(); defer { lock.unlock() }
            _partial = ""
        }
    }

    static func main(_ arguments: [String]) async {
        var chunkSizeMs = 320
        var eouDebounceMs = 1280
        var modelsPath: String?
        var computeUnits = "all"
        // Safety net for the case where EOU never confirms — noisy input, or someone
        // who runs sentences together. Without it, words that never get a clean silence
        // gap stay stuck in partials and never become a transcript line.
        var stableMs = 1500

        var i = 0
        while i < arguments.count {
            switch arguments[i] {
            case "--chunk-ms":
                if i + 1 < arguments.count { chunkSizeMs = Int(arguments[i + 1]) ?? 320; i += 1 }
            case "--eou-debounce-ms":
                if i + 1 < arguments.count { eouDebounceMs = Int(arguments[i + 1]) ?? 1280; i += 1 }
            case "--models":
                if i + 1 < arguments.count { modelsPath = arguments[i + 1]; i += 1 }
            case "--compute-units":
                if i + 1 < arguments.count { computeUnits = arguments[i + 1]; i += 1 }
            case "--stable-ms":
                if i + 1 < arguments.count { stableMs = Int(arguments[i + 1]) ?? 1500; i += 1 }
            case "-h", "--help":
                log("usage: fluidaudiocli parakeet-stream [--chunk-ms 160|320|1280] [--eou-debounce-ms N] [--stable-ms N] [--models PATH] [--compute-units all|cpuOnly|cpuAndGpu]")
                log("reads s16le 16kHz mono PCM on stdin, emits NDJSON on stdout")
                return
            default:
                break
            }
            i += 1
        }

        let chunkSize: StreamingChunkSize
        switch chunkSizeMs {
        case 160: chunkSize = .ms160
        case 1280: chunkSize = .ms1280
        default: chunkSize = .ms320
        }

        let modelsUrl: URL =
            modelsPath.map { URL(fileURLWithPath: $0).standardized }
            ?? ParakeetEouCommand.getModelsDirectory().appendingPathComponent(chunkSize.modelSubdirectory)

        if !FileManager.default.fileExists(atPath: modelsUrl.path) {
            log("models missing at \(modelsUrl.path) — downloading (first run only, this can take a while)")
            do {
                let repo: Repo
                switch chunkSize {
                case .ms160: repo = .parakeetEou160
                case .ms320: repo = .parakeetEou320
                default: repo = .parakeetEou1280
                }
                // ModelHub appends the repo's own folderName ("parakeet-eou-streaming/320ms"),
                // so the destination root is two levels up from the resolved model dir.
                try await ModelHub.download(
                    repo, to: modelsUrl.deletingLastPathComponent().deletingLastPathComponent())
                log("models downloaded")
            } catch {
                log("model download failed: \(error)")
                emit(["type": "error", "message": "model download failed: \(error)"])
                exit(1)
            }
        }

        let config = MLModelConfiguration()
        switch computeUnits {
        case "cpuOnly": config.computeUnits = .cpuOnly
        case "cpuAndGpu": config.computeUnits = .cpuAndGPU
        default: config.computeUnits = .all
        }

        let manager = StreamingEouAsrManager(
            configuration: config, chunkSize: chunkSize, eouDebounceMs: eouDebounceMs, debugFeatures: false)

        do {
            log("loading models from \(modelsUrl.path)")
            try await manager.loadModels(from: modelsUrl)
            log("models loaded")
        } catch {
            log("failed to load models: \(error)")
            emit(["type": "error", "message": "failed to load models: \(error)"])
            exit(1)
        }

        let box = Box()
        await manager.setPartialCallback { text in box.setPartial(text) }
        await manager.setEouCallback { text in box.pushFinal(text) }

        guard
            let format = AVAudioFormat(
                commonFormat: .pcmFormatFloat32, sampleRate: 16000, channels: 1, interleaved: false)
        else {
            emit(["type": "error", "message": "could not create 16kHz mono format"])
            exit(1)
        }

        emit(["type": "ready"])
        log("ready — chunk \(chunkSize.durationMs)ms, eou debounce \(eouDebounceMs)ms")

        let stdinHandle = FileHandle.standardInput
        var lastPartial = ""
        var lastPartialChange = Date()

        while true {
            let data = stdinHandle.availableData
            if data.isEmpty { break }  // EOF: host closed the pipe

            guard let buffer = makeBuffer(from: data, format: format) else { continue }

            do {
                _ = try await manager.process(audioBuffer: buffer)
            } catch {
                log("process error: \(error)")
                emit(["type": "error", "message": "\(error)"])
                continue
            }

            // An EOU closes an utterance. reset() is what re-arms detection and clears
            // the accumulator, and it must happen out here rather than in the callback.
            let finals = box.drainFinals()
            if !finals.isEmpty {
                for text in finals {
                    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
                    if !trimmed.isEmpty { emit(["type": "final", "text": trimmed]) }
                }
                box.clearPartial()
                lastPartial = ""
                lastPartialChange = Date()
                await manager.reset()
                continue
            }

            let partial = box.takePartial().trimmingCharacters(in: .whitespacesAndNewlines)
            if !partial.isEmpty && partial != lastPartial {
                lastPartial = partial
                lastPartialChange = Date()
                emit(["type": "partial", "text": partial])
            } else if !partial.isEmpty,
                Date().timeIntervalSince(lastPartialChange) * 1000 >= Double(stableMs)
            {
                // Text stopped growing but EOU never confirmed. Close it ourselves
                // rather than leave recognised words stranded in a partial forever.
                emit(["type": "final", "text": partial])
                box.clearPartial()
                lastPartial = ""
                lastPartialChange = Date()
                await manager.reset()
            }
        }

        // Flush whatever is still buffered when the host closes the pipe.
        do {
            let tail = try await manager.finish().trimmingCharacters(in: .whitespacesAndNewlines)
            if !tail.isEmpty { emit(["type": "final", "text": tail]) }
        } catch {
            log("finish error: \(error)")
        }
        await manager.cleanup()
        log("stream closed")
    }

    /// s16le bytes -> float32 mono buffer. The manager resamples internally, but it is
    /// already at 16 kHz so this is a straight scale.
    static func makeBuffer(from data: Data, format: AVAudioFormat) -> AVAudioPCMBuffer? {
        let sampleCount = data.count / 2
        guard sampleCount > 0,
            let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(sampleCount)),
            let channel = buffer.floatChannelData?[0]
        else { return nil }

        data.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
            for i in 0..<sampleCount {
                let lo = UInt16(raw[i * 2])
                let hi = UInt16(raw[i * 2 + 1])
                let sample = Int16(bitPattern: lo | (hi << 8))
                channel[i] = Float(sample) / 32768.0
            }
        }
        buffer.frameLength = AVAudioFrameCount(sampleCount)
        return buffer
    }
}
