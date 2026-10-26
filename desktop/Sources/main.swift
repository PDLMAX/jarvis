import Cocoa
import WebKit

// 后端地址（本地 Flask）
let backendBase = "http://127.0.0.1:5001"

/// 定位后端项目根目录：JARVIS.app 位于 <repo>/desktop/，后端在 <repo>/
var backendDir: String {
    Bundle.main.bundleURL.deletingLastPathComponent().deletingLastPathComponent().path
}

/// 诊断日志：GUI 双击启动时 NSLog 不进 unified log，写文件才能可靠读取
let speechLogPath = "/tmp/jarvis_speech.log"
func slog(_ fmt: String, _ args: CVarArg...) {
    let msg = String(format: fmt, arguments: args)
    NSLog("[JARVIS] %@", msg)
    let line = "[\(Date())] \(msg)\n"
    let url = URL(fileURLWithPath: speechLogPath)
    if let fh = try? FileHandle(forWritingTo: url) {
        defer { try? fh.close() }
        _ = try? fh.seekToEnd()
        try? fh.write(contentsOf: line.data(using: .utf8)!)
    } else {
        try? line.data(using: .utf8)?.write(to: url)
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
    var window: NSWindow!
    var webView: WKWebView!
    let speech = SpeechController()

    func applicationDidFinishLaunching(_ notification: Notification) {
        speech.onText = { [weak self] text in self?.sendText(text) }
        speech.onState = { _ in
            // 状态通过网页端 UI 展示（中心圆圈的按下态由 main.js 控制）
        }
        speech.onError = { [weak self] msg in
            guard let self = self, self.webView != nil else { return }
            let safe = msg.replacingOccurrences(of: "'", with: "\\'")
            self.webView.evaluateJavaScript("window.jarvisVoiceError && window.jarvisVoiceError('\(safe)')", completionHandler: nil)
        }

        buildMenu()
        buildWindow()
        ensureBackend()
        loadUI()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    // MARK: 窗口

    func buildWindow() {
        let rect = NSRect(x: 0, y: 0, width: 1280, height: 820)
        window = NSWindow(contentRect: rect,
                          styleMask: [.titled, .closable, .miniaturizable, .resizable],
                          backing: .buffered, defer: false)
        window.title = "J·A·R·V·I·S"
        window.minSize = NSSize(width: 900, height: 600)
        window.center()

        let config = WKWebViewConfiguration()
        config.mediaTypesRequiringUserActionForPlayback = []
        config.userContentController.add(self, name: "voice")
        webView = WKWebView(frame: rect, configuration: config)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.autoresizingMask = [.width, .height]
        window.contentView = webView

        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func buildMenu() {
        let main = NSMenu()
        let appItem = NSMenuItem()
        main.addItem(appItem)
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "退出 J·A·R·V·I·S",
                        action: #selector(NSApplication.terminate(_:)),
                        keyEquivalent: "q")
        appItem.submenu = appMenu

        // 视图菜单：Cmd+R 刷新页面（WKWebView 无原生刷新 UI）
        let viewItem = NSMenuItem()
        main.addItem(viewItem)
        let viewMenu = NSMenu(title: "显示")
        let reloadItem = NSMenuItem(title: "刷新页面",
                                    action: #selector(reloadUI),
                                    keyEquivalent: "r")
        reloadItem.target = self
        viewMenu.addItem(reloadItem)
        viewItem.submenu = viewMenu
        NSApp.mainMenu = main
    }

    @objc func reloadUI() {
        webView.reload()
    }

    // MARK: 网页 → 原生语音桥接（空格 / 中间圈走 SFSpeechRecognizer）
    func userContentController(_ userContentController: WKUserContentController,
                               didReceive message: WKScriptMessage) {
        guard message.name == "voice",
              let body = message.body as? [String: Any],
              let action = body["action"] as? String else { return }
        if action == "start" { slog("桥接收到 action=start"); speech.start() }
        else if action == "stop" { slog("桥接收到 action=stop"); speech.stop() }
    }

    // MARK: 后端

    func loadUI() {
        webView.load(URLRequest(url: URL(string: backendBase + "/")!))
    }

    func ensureBackend() {
        if isBackendUp() { return }
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/bin/bash")
        task.arguments = [backendDir + "/run.sh"]
        task.currentDirectoryURL = URL(fileURLWithPath: backendDir)
        do { try task.run() } catch { NSLog("启动后端失败: \(error)") }
        for _ in 0..<60 {
            if isBackendUp() { return }
            Thread.sleep(forTimeInterval: 0.5)
        }
    }

    func isBackendUp() -> Bool {
        var req = URLRequest(url: URL(string: backendBase + "/")!)
        req.timeoutInterval = 2
        var ok = false
        let sem = DispatchSemaphore(value: 0)
        URLSession.shared.dataTask(with: req) { _, resp, _ in
            if let r = resp as? HTTPURLResponse, r.statusCode == 200 { ok = true }
            sem.signal()
        }.resume()
        _ = sem.wait(timeout: .now() + 2.5)
        return ok
    }

    // MARK: 语音

    func sendText(_ text: String) {
        var req = URLRequest(url: URL(string: backendBase + "/api/voice")!)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: ["text": text, "engine": "doubao"])
        URLSession.shared.dataTask(with: req).resume()
    }

    // MARK: WKWebView delegate

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        // 后端尚未就绪时自动重试
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { [weak self] in self?.loadUI() }
    }

    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                 initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType,
                 decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        decisionHandler(.grant)
    }
}

// 入口
let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
