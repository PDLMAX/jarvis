import Cocoa
import AVFoundation

/// 语音采集控制器：只负责录音，把 16kHz/16bit/mono 原始 PCM 推给本地后端，
/// 由后端转发到火山引擎 ASR（国内直连、免 VPN）完成识别。
///
/// 为什么不再用苹果 SFSpeechRecognizer：
///   * 本机长期报 kAFAssistantErrorDomain 1110 "No speech detected"；
///   * `SFSpeechRecognizer.requestAuthorization` 每次按键都调用会造成数秒到数十秒卡顿，
///     用户往往在真正开始录音前就已松手，导致一个采样点都没录到（声道=[]、-120dB）；
///   * `audioEngine.reset()` 会让下一次 start 的 tap 不再回调。
/// 现在只需要麦克风权限，不再需要「语音识别」权限。
final class SpeechController: NSObject {
    private let audioEngine = AVAudioEngine()
    /// 串行发送队列：保证音频分片按顺序到达后端
    private let sendQueue = DispatchQueue(label: "jarvis.asr.send")

    private var listening = false
    /// beginCapture 正在进行中（网络请求 + 引擎启动，可能耗时数百毫秒到数秒）
    private var starting = false
    /// starting 期间收到了 stop：录音一启动就立即自拆，避免孤儿会话
    private var stopRequested = false
    /// 兜底定时器：超长录音自动结束
    private var safetyTimer: DispatchWorkItem?
    private let maxRecordSeconds: TimeInterval = 60

    private var sid: String = ""
    private var tapInstalled = false

    /// 累积到约 200ms 再上传，减少 HTTP 请求数
    private var pending = Data()
    private let chunkBytes = 16000 * 2 * 200 / 1000   // 6400 bytes = 200ms

    // 诊断
    private var maxDb: Float = -120
    private var sentChunks = 0

    var onText: ((String) -> Void)?
    var onState: ((Bool) -> Void)?
    var onError: ((String) -> Void)?

    // MARK: - 对外接口

    func start() {
        if listening || starting { return }
        starting = true
        stopRequested = false
        slog("[ASR] start() micAuth=%d",
             AVCaptureDevice.authorizationStatus(for: .audio).rawValue)

        requestMic { [weak self] ok in
            guard let self = self else { return }
            guard ok else {
                self.starting = false
                self.emitError("麦克风权限被拒绝，请到 系统设置 - 隐私与安全 - 麦克风 允许 JARVIS")
                return
            }
            // 联网/HTTP 一律放后台，绝不阻塞主线程（这是之前卡顿的根源之一）
            DispatchQueue.global(qos: .userInitiated).async {
                self.beginCapture()
            }
        }
    }

    func stop() {
        // 录音尚未真正启动就收到 stop：打标，让 beginCapture 启动后立即自拆。
        // 否则会出现「没人能停」的孤儿会话（实测曾连录 12 分钟直到服务端超时）。
        if starting {
            stopRequested = true
            slog("[ASR] stop() 早于录音启动，已标记取消")
            DispatchQueue.main.async { self.onState?(false) }
            return
        }
        guard listening else { return }
        slog("[ASR] stop() sentChunks=%d maxLevel=%.1fdB", sentChunks, maxDb)
        listening = false
        safetyTimer?.cancel()
        safetyTimer = nil
        stopEngine()

        let curSid = sid
        sid = ""
        DispatchQueue.main.async { self.onState?(false) }
        guard !curSid.isEmpty else { return }

        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self = self else { return }
            self.flushPending()                       // 送出最后不足一片的音频
            let text = self.postStop(sid: curSid)
            slog("[ASR] finalText=%@", text.isEmpty ? "(empty)" : text)
            DispatchQueue.main.async {
                if text.isEmpty {
                    self.emitError("没有听清，请再说一次（靠近麦克风、稍微大声一点）")
                } else {
                    self.onText?(text)
                }
            }
        }
    }

    // MARK: - 权限（只请求麦克风，不再请求语音识别）

    private func requestMic(_ done: @escaping (Bool) -> Void) {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized:
            done(true)                                  // 已授权，同步返回，零延迟
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .audio) { granted in
                DispatchQueue.main.async { done(granted) }
            }
        default:
            done(false)
        }
    }

    // MARK: - 采集

    private func beginCapture() {
        // 1) 向后端开启识别会话
        guard let newSid = postStart() else {
            starting = false
            emitError("语音识别服务启动失败，请确认后端已运行且已配置火山引擎密钥")
            return
        }
        sid = newSid
        sentChunks = 0
        maxDb = -120
        pending = Data()

        // 2) 安装 tap：format 传 nil，让 AVFoundation 用节点自身的输出格式，
        //    避免手动指定格式与硬件不符导致 tap 永不回调。
        let input = audioEngine.inputNode
        let fmt = input.outputFormat(forBus: 0)
        slog("[ASR] inputFormat sampleRate=%.0f channels=%d",
             fmt.sampleRate, Int(fmt.channelCount))
        guard fmt.channelCount > 0, fmt.sampleRate > 0 else {
            starting = false
            sid = ""
            emitError("未检测到可用的麦克风输入设备")
            return
        }

        if tapInstalled {
            input.removeTap(onBus: 0)
            tapInstalled = false
        }
        input.installTap(onBus: 0, bufferSize: 4096, format: nil) { [weak self] buffer, _ in
            self?.handle(buffer: buffer)
        }
        tapInstalled = true

        // 3) 启动引擎
        audioEngine.prepare()
        do {
            try audioEngine.start()
        } catch {
            slog("[ASR] audioEngine.start failed: %@", String(describing: error))
            if tapInstalled { input.removeTap(onBus: 0); tapInstalled = false }
            starting = false
            sid = ""
            emitError("音频引擎启动失败：\(error.localizedDescription)")
            return
        }

        listening = true
        starting = false
        slog("[ASR] recording sid=%@", String(newSid.prefix(8)))

        // 启动期间用户已松手 -> 立即结束，不留孤儿会话
        if stopRequested {
            stopRequested = false
            slog("[ASR] 启动期间已收到 stop，立即结束本次录音")
            stop()
            return
        }
        DispatchQueue.main.async { self.onState?(true) }
        scheduleSafetyStop()
    }

    /// 兜底：超过最长录音时长自动结束，防止会话失控（后端也有超时，但双保险）
    private func scheduleSafetyStop() {
        safetyTimer?.cancel()
        let item = DispatchWorkItem { [weak self] in
            guard let self = self, self.listening else { return }
            slog("[ASR] 达到最长录音 %.0fs，自动结束", self.maxRecordSeconds)
            self.stop()
        }
        safetyTimer = item
        DispatchQueue.main.asyncAfter(deadline: .now() + maxRecordSeconds, execute: item)
    }

    private func stopEngine() {
        if tapInstalled {
            audioEngine.inputNode.removeTap(onBus: 0)
            tapInstalled = false
        }
        audioEngine.stop()
        // 注意：不要调用 audioEngine.reset()，它会让下一次 start 的 tap 不再回调。
    }

    // MARK: - 音频处理：多声道 float -> 16kHz mono Int16 PCM

    private func handle(buffer: AVAudioPCMBuffer) {
        guard listening, let chData = buffer.floatChannelData else { return }
        let frames = Int(buffer.frameLength)
        let chs = Int(buffer.format.channelCount)
        guard frames > 0, chs > 0 else { return }

        let srcRate = Int(buffer.format.sampleRate)
        let dstRate = 16000
        guard srcRate > 0 else { return }

        // 诊断：记录原始信号峰值电平
        var peak: Float = 0
        for c in 0..<chs {
            for i in 0..<frames {
                let a = abs(chData[c][i])
                if a > peak { peak = a }
            }
        }
        if peak > 0 {
            let db = 20 * log10(peak)
            if db > maxDb { maxDb = db }
        }

        // 重采样（线性插值）+ 多声道混音
        let outFrames = frames * dstRate / srcRate
        guard outFrames > 0 else { return }
        var out = [Int16](repeating: 0, count: outFrames)
        let ratio = Double(srcRate) / Double(dstRate)
        let invCh = 1.0 / Float(chs)

        for i in 0..<outFrames {
            let pos = Double(i) * ratio
            let i0 = Int(pos)
            guard i0 < frames else { break }
            let i1 = min(i0 + 1, frames - 1)
            let frac = Float(pos - Double(i0))
            // 各声道线性插值后取平均
            var s: Float = 0
            for c in 0..<chs {
                let a = chData[c][i0]
                let b = chData[c][i1]
                s += a * (1 - frac) + b * frac
            }
            s *= invCh
            // 云端 ASR 对自然电平最友好，不做激进增益，仅防爆音软削波
            if s > 0.99 { s = 0.99 } else if s < -0.99 { s = -0.99 }
            out[i] = Int16(s * 32767.0)
        }

        pending.append(out.withUnsafeBytes { Data($0) })
        if pending.count >= chunkBytes {
            flushPending()
        }
    }

    private func flushPending() {
        guard !pending.isEmpty else { return }
        let data = pending
        pending = Data()
        postChunk(data)
    }

    // MARK: - HTTP

    /// 开启会话。直接在当前后台线程同步等待（不经 sendQueue），
    /// 否则会出现「两个 waiter 争一个 semaphore」导致白等超时。
    private func postStart() -> String? {
        guard let url = URL(string: backendBase + "/api/asr/start") else { return nil }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.timeoutInterval = 15
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = Data("{}".utf8)

        var result: String?
        let sem = DispatchSemaphore(value: 0)
        URLSession.shared.dataTask(with: req) { data, _, err in
            defer { sem.signal() }
            if let err = err {
                slog("[ASR] start failed: %@", String(describing: err)); return
            }
            guard let data = data,
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            else { return }
            if let s = obj["sid"] as? String, (obj["ok"] as? Bool) == true {
                result = s
            } else if let e = obj["error"] as? String {
                slog("[ASR] start rejected: %@", e)
            }
        }.resume()
        _ = sem.wait(timeout: .now() + 20)
        return result
    }

    /// 发送一段 PCM。经 sendQueue 串行执行以保证顺序。
    private func postChunk(_ data: Data) {
        let curSid = sid
        guard !curSid.isEmpty, !data.isEmpty else { return }
        sendQueue.async { [weak self] in
            guard let self = self,
                  let url = URL(string: backendBase + "/api/asr/chunk?sid=\(curSid)") else { return }
            var req = URLRequest(url: url)
            req.httpMethod = "POST"
            req.timeoutInterval = 10
            req.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
            req.httpBody = data
            let sem = DispatchSemaphore(value: 0)
            URLSession.shared.dataTask(with: req) { _, _, err in
                defer { sem.signal() }
                if let err = err { slog("[ASR] chunk failed: %@", String(describing: err)) }
            }.resume()
            sem.wait()
            self.sentChunks += 1
        }
    }

    /// 结束会话并取回最终文本。必须走 sendQueue 以排在所有音频分片之后。
    /// 内/外各用独立 semaphore，避免两个 waiter 争一个信号。
    private func postStop(sid curSid: String) -> String {
        var text = ""
        let done = DispatchSemaphore(value: 0)
        sendQueue.async {
            guard let url = URL(string: backendBase + "/api/asr/stop?sid=\(curSid)") else {
                done.signal(); return
            }
            var req = URLRequest(url: url)
            req.httpMethod = "POST"
            req.timeoutInterval = 30
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = Data("{}".utf8)
            let inner = DispatchSemaphore(value: 0)
            URLSession.shared.dataTask(with: req) { data, _, err in
                defer { inner.signal() }
                if let err = err {
                    slog("[ASR] stop failed: %@", String(describing: err)); return
                }
                guard let data = data,
                      let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
                else { return }
                if let t = obj["text"] as? String { text = t }
                if let e = obj["error"] as? String, !e.isEmpty, text.isEmpty {
                    slog("[ASR] stop error: %@", e)
                }
            }.resume()
            inner.wait()
            done.signal()
        }
        _ = done.wait(timeout: .now() + 35)
        return text.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func emitError(_ msg: String) {
        slog("[ASR] error: %@", msg)
        DispatchQueue.main.async {
            self.onError?(msg)
            self.onState?(false)
        }
    }
}
