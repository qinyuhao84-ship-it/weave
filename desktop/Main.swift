import Cocoa
import WebKit

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate {
    var window: NSWindow!
    var web: WKWebView!
    var process: Process?
    var baseURL: URL?
    var serverPID: Int32?
    var buffer = ""
    var closing = false
    var terminationSignal: DispatchSourceSignal?
    var quitDeadline: DispatchWorkItem?
    var terminationReplied = false
    var presentingFailure = false
    var checkingVaultAccess = false
    var launcherStderrBytes = 0
    var launcherStderrTruncationLogged = false
    var provisionalNavigationURLs: [ObjectIdentifier: String] = [:]
    var pendingDownloadPolicyURLs: [String: Date] = [:]
    var downloadDestinations: [ObjectIdentifier: URL] = [:]
    var supportURL: URL {
        if let root = ProcessInfo.processInfo.environment["WEAVE_DESKTOP_TEST_ROOT"] { return URL(fileURLWithPath: root) }
        return FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/Weave")
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        if let identifier = Bundle.main.bundleIdentifier,
           let previous = NSRunningApplication.runningApplications(withBundleIdentifier: identifier).first(where: { $0.processIdentifier != ProcessInfo.processInfo.processIdentifier }) {
            previous.activate(options: [.activateAllWindows]); NSApp.terminate(nil); return
        }
        signal(SIGTERM, SIG_IGN)
        terminationSignal = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
        terminationSignal?.setEventHandler { NSApp.terminate(nil) }; terminationSignal?.resume()
        installMenus()
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1200, height: 800), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "织识"; window.minSize = NSSize(width: 620, height: 480); window.delegate = self
        let frameName = ProcessInfo.processInfo.environment["WEAVE_DESKTOP_TEST_ROOT"] == nil ? "WeaveMainWindow" : "WeaveAcceptanceWindow"
        if !window.setFrameUsingName(frameName) { window.center() }
        window.setFrameAutosaveName(frameName)
        web = WKWebView(frame: window.contentView!.bounds)
        web.autoresizingMask = [.width, .height]; web.navigationDelegate = self; web.uiDelegate = self
        window.contentView!.addSubview(web)
        window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true)
        startService()
    }

    func startService() {
        guard !closing, !checkingVaultAccess, process?.isRunning != true else { return }
        baseURL = nil; serverPID = nil; buffer = ""
        launcherStderrBytes = 0; launcherStderrTruncationLogged = false
        window.subtitle = "正在打开"
        web.loadHTMLString("""
        <!doctype html><html lang="zh"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
        :root{color-scheme:light dark}body{margin:0;background:#f4f2ed;color:#292b25;font:15px -apple-system,system-ui;display:grid;place-items:center;height:100vh}
        main{text-align:center}svg{width:44px;height:44px;margin-bottom:24px}h1{font-size:23px;font-weight:500;margin:0 0 12px}p{color:#73756a;margin:0}
        @media(prefers-color-scheme:dark){body{background:#1b1e1a;color:#e4e6dc}p{color:#a0a593}}
        </style><main><svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M5 21L8 18M12 14L21 5M11 27L20 18M24 14L27 11M5 11L14 20M18 24L21 27M11 5L14 8M18 12L27 21"/></svg><h1>织识</h1><p>正在打开本地知识库，请稍候…</p><p style="margin-top:12px">如 macOS 询问文件夹访问，请允许读取知识库。</p></main></html>
        """, baseURL: nil)
        // 系统首次授权可能等待用户很久；取得目录访问后才启动服务计时。
        checkingVaultAccess = true
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            do {
                try Self.checkVaultAccess()
                DispatchQueue.main.async {
                    guard let self = self else { return }
                    self.checkingVaultAccess = false
                    if !self.closing { self.launchService() }
                }
            } catch {
                DispatchQueue.main.async {
                    guard let self = self else { return }
                    self.checkingVaultAccess = false
                    if !self.closing { self.showFailure("无法读取知识库文件夹。请在系统设置的隐私与安全性中允许织识访问该文件夹，然后重试。\(error.localizedDescription)") }
                }
            }
        }
    }

    static func checkVaultAccess() throws {
        let environment = ProcessInfo.processInfo.environment
        let manager = FileManager.default
        let home = manager.homeDirectoryForCurrentUser
        var roots: [URL]
        if let testRoot = environment["WEAVE_DESKTOP_TEST_ROOT"] {
            roots = [URL(fileURLWithPath: testRoot).appendingPathComponent("vault")]
        } else if let root = environment["WEAVE_VAULT"], !root.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            roots = [URL(fileURLWithPath: root.trimmingCharacters(in: .whitespacesAndNewlines))]
        } else {
            let configDirectory = environment["WEAVE_CONFIG_DIR"].map { URL(fileURLWithPath: $0) } ?? home.appendingPathComponent("Library/Application Support/Weave")
            let config = configDirectory.appendingPathComponent("vault-location.json")
            var location: [String: Any] = [:]
            if manager.fileExists(atPath: config.path) {
                location = try JSONSerialization.jsonObject(with: Data(contentsOf: config)) as? [String: Any] ?? [:]
            }
            if let move = location["pendingMove"] as? [String: String], let from = move["from"], let to = move["to"] {
                roots = [URL(fileURLWithPath: from), URL(fileURLWithPath: to)]
            } else {
                roots = [(location["activeRoot"] as? String).map { URL(fileURLWithPath: $0) } ?? home.appendingPathComponent("Documents/织识")]
            }
        }
        for root in roots {
            var directory = root.standardizedFileURL
            while !manager.fileExists(atPath: directory.path), directory.path != "/" { directory.deleteLastPathComponent() }
            _ = try manager.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil, options: [])
        }
    }

    func launchService() {
        guard !closing, process?.isRunning != true else { return }
        let resources = Bundle.main.resourceURL!
        let child = Process(); child.executableURL = resources.appendingPathComponent("runtime/bin/node")
        child.arguments = [resources.appendingPathComponent("launcher.mjs").path]
        let output = Pipe(); let errors = Pipe(); child.standardOutput = output; child.standardError = errors
        errors.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty else { handle.readabilityHandler = nil; return }
            guard let self = self else { return }
            let limit = 16_384
            let remaining = max(0, limit - self.launcherStderrBytes)
            if remaining == 0 {
                if !self.launcherStderrTruncationLogged {
                    self.launcherStderrTruncationLogged = true
                    DispatchQueue.main.async { self.appendDiagnostic("启动器 stderr 超过 16 KiB，后续内容已截断。") }
                }
                return
            }
            let captured = data.prefix(remaining)
            self.launcherStderrBytes += captured.count
            let message = String(decoding: captured, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
            if !message.isEmpty { DispatchQueue.main.async { self.appendDiagnostic("启动器 stderr：\(message)") } }
            if captured.count < data.count && !self.launcherStderrTruncationLogged {
                self.launcherStderrTruncationLogged = true
                DispatchQueue.main.async { self.appendDiagnostic("启动器 stderr 超过 16 KiB，后续内容已截断。") }
            }
        }
        output.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty, let text = String(data: data, encoding: .utf8) else { return }
            DispatchQueue.main.async {
                guard let self = self, !self.closing else { return }
                self.buffer += text
                while let newline = self.buffer.firstIndex(of: "\n") {
                    let line = String(self.buffer[..<newline]); self.buffer.removeSubrange(...newline)
                    guard let bytes = line.data(using: .utf8), let record = try? JSONSerialization.jsonObject(with: bytes) as? [String: String],
                          let address = record["url"], let url = URL(string: address), url.scheme == "http", url.host == "127.0.0.1", url.port != nil else { continue }
                    self.serverPID = record["serverPid"].flatMap(Int32.init)
                    self.baseURL = url; self.web.load(URLRequest(url: url)); self.window.subtitle = ""
                }
                if self.buffer.count > 16_384 { self.buffer = "" }
            }
        }
        child.terminationHandler = { [weak self] _ in
            output.fileHandleForReading.readabilityHandler = nil; errors.fileHandleForReading.readabilityHandler = nil
            DispatchQueue.main.async {
                guard let self = self else { return }
                self.process = nil
                let orphanedServer = self.serverPID
                if self.closing {
                    self.stopOrphanedServer(orphanedServer) { self.replyToTermination() }
                } else {
                    self.appendDiagnostic("本地服务进程意外退出。")
                    self.stopOrphanedServer(orphanedServer) {
                        self.showFailure("本地服务已停止。您的知识库保留在原位置，可重试打开并检查日志。")
                    }
                }
            }
        }
        process = child
        do { try child.run() } catch { process = nil; showFailure("无法启动随应用提供的运行时。请核对安装包，或检查应用支持目录的权限与剩余空间。") }
    }

    func installMenus() {
        let menu = NSMenu(); let appItem = NSMenuItem(); menu.addItem(appItem)
        let appMenu = NSMenu(); appItem.submenu = appMenu
        appMenu.addItem(withTitle: "关于织识", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator()); appMenu.addItem(withTitle: "设置…", action: #selector(openSettings), keyEquivalent: ",").target = self
        appMenu.addItem(.separator())
        let services = NSMenu(title: "服务"); let servicesItem = NSMenuItem(title: "服务", action: nil, keyEquivalent: ""); servicesItem.submenu = services; appMenu.addItem(servicesItem); NSApp.servicesMenu = services
        appMenu.addItem(.separator()); appMenu.addItem(withTitle: "隐藏织识", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(withTitle: "隐藏其他", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h").keyEquivalentModifierMask = [.command, .option]
        appMenu.addItem(withTitle: "显示全部", action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: "")
        appMenu.addItem(.separator()); appMenu.addItem(withTitle: "退出织识", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        let editItem = NSMenuItem(); menu.addItem(editItem); let edit = NSMenu(title: "编辑"); editItem.submenu = edit
        edit.addItem(withTitle: "撤销", action: Selector(("undo:")), keyEquivalent: "z")
        edit.addItem(withTitle: "重做", action: Selector(("redo:")), keyEquivalent: "z").keyEquivalentModifierMask = [.command, .shift]
        edit.addItem(.separator())
        for (title, selector, key) in [("剪切", "cut:", "x"), ("复制", "copy:", "c"), ("粘贴", "paste:", "v"), ("全选", "selectAll:", "a")] { edit.addItem(withTitle: title, action: Selector(selector), keyEquivalent: key) }
        let windowItem = NSMenuItem(); menu.addItem(windowItem); let windows = NSMenu(title: "窗口"); windowItem.submenu = windows; NSApp.windowsMenu = windows
        windows.addItem(withTitle: "最小化", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        windows.addItem(withTitle: "缩放", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
        windows.addItem(withTitle: "进入全屏", action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f").keyEquivalentModifierMask = [.command, .control]
        windows.addItem(.separator()); windows.addItem(withTitle: "全部前置", action: #selector(NSApplication.arrangeInFront(_:)), keyEquivalent: "")
        let helpItem = NSMenuItem(); menu.addItem(helpItem); let help = NSMenu(title: "帮助"); helpItem.submenu = help; NSApp.helpMenu = help
        help.addItem(withTitle: "织识使用说明", action: #selector(openHelp), keyEquivalent: "").target = self
        help.addItem(withTitle: "打开诊断日志", action: #selector(openLogs), keyEquivalent: "").target = self
        NSApp.mainMenu = menu
    }

    @objc func openSettings() { if let url = baseURL?.appendingPathComponent("settings") { window.makeKeyAndOrderFront(nil); web.load(URLRequest(url: url)) } }
    @objc func openLogs() {
        try? FileManager.default.createDirectory(at: supportURL, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        NSWorkspace.shared.open(supportURL)
    }
    @objc func openHelp() { if let url = Bundle.main.resourceURL?.appendingPathComponent("使用说明.html") { NSWorkspace.shared.open(url) } }
    func appendDiagnostic(_ message: String) {
        do {
            try FileManager.default.createDirectory(at: supportURL, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            let logURL = supportURL.appendingPathComponent("desktop.log")
            if !FileManager.default.fileExists(atPath: logURL.path) { FileManager.default.createFile(atPath: logURL.path, contents: nil, attributes: [.posixPermissions: 0o600]) }
            let log = try FileHandle(forWritingTo: logURL)
            try log.seekToEnd()
            try log.write(contentsOf: Data("[desktop] \(ISO8601DateFormatter().string(from: Date())) \(message)\n".utf8))
            try log.close()
        } catch { /* 日志写入失败时仍显示可操作的系统提示。 */ }
    }
    func expectDownloadPolicyTransition(_ url: URL?) {
        guard let url = url else { return }
        let now = Date()
        pendingDownloadPolicyURLs = pendingDownloadPolicyURLs.filter { $0.value > now }
        pendingDownloadPolicyURLs[url.absoluteString] = now.addingTimeInterval(15)
    }
    func clearDownloadPolicyTransition(_ download: WKDownload) {
        if let url = download.originalRequest?.url?.absoluteString { pendingDownloadPolicyURLs.removeValue(forKey: url) }
    }
    func isExpectedDownloadPolicyInterruption(_ error: Error, navigation: WKNavigation?, webView: WKWebView) -> Bool {
        let failure = error as NSError
        guard failure.domain == "WebKitErrorDomain", failure.code == 102 else { return false }
        let now = Date()
        pendingDownloadPolicyURLs = pendingDownloadPolicyURLs.filter { $0.value > now }
        var candidates: [String] = []
        if let url = failure.userInfo[NSURLErrorFailingURLStringErrorKey] as? String { candidates.append(url) }
        if let url = failure.userInfo[NSURLErrorFailingURLErrorKey] as? URL { candidates.append(url.absoluteString) }
        if let navigation = navigation,
           let url = provisionalNavigationURLs.removeValue(forKey: ObjectIdentifier(navigation)) { candidates.append(url) }
        if let url = webView.url { candidates.append(url.absoluteString) }
        guard let matched = candidates.first(where: { pendingDownloadPolicyURLs[$0] != nil }) else { return false }
        pendingDownloadPolicyURLs.removeValue(forKey: matched)
        appendDiagnostic("已忽略与已选择下载一致的 WebKitErrorDomain 102 导航策略中断。")
        return true
    }
    func processIsRunning(_ pid: Int32) -> Bool {
        if kill(pid, 0) == 0 { return true }
        return errno == EPERM
    }
    func stopOrphanedServer(_ pid: Int32?, completion: @escaping () -> Void) {
        guard let pid = pid, processIsRunning(pid) else { serverPID = nil; completion(); return }
        appendDiagnostic("启动器已退出；正在清理遗留的本地服务进程。")
        kill(pid, SIGTERM)
        let deadline = Date().addingTimeInterval(8)
        func check() {
            if !processIsRunning(pid) { serverPID = nil; completion(); return }
            if Date() >= deadline {
                kill(pid, SIGKILL); serverPID = nil
                appendDiagnostic("本地服务未响应终止信号，已发送强制退出信号。")
                completion(); return
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.1, execute: check)
        }
        check()
    }
    func replyToTermination() {
        guard !terminationReplied else { return }
        terminationReplied = true; quitDeadline?.cancel(); NSApp.reply(toApplicationShouldTerminate: true)
    }
    func showFailure(_ text: String, retry: (() -> Void)? = nil) {
        guard !closing, !presentingFailure else { return }
        appendDiagnostic(text)
        presentingFailure = true; window.subtitle = "需要检查"
        while !closing {
            let alert = NSAlert(); alert.alertStyle = .warning; alert.messageText = "织识暂时无法打开"; alert.informativeText = text
            alert.addButton(withTitle: "重试打开"); alert.addButton(withTitle: "打开日志"); alert.addButton(withTitle: "退出")
            let answer = alert.runModal()
            if answer == .alertFirstButtonReturn { presentingFailure = false; if let retry = retry { retry() } else { startService() }; return }
            if answer == .alertSecondButtonReturn { openLogs(); continue }
            presentingFailure = false; NSApp.terminate(nil); return
        }
        presentingFailure = false
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool { window?.makeKeyAndOrderFront(nil); return true }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if closing { return .terminateLater }
        closing = true; terminationReplied = false; window?.subtitle = "正在安全退出"
        guard let child = process, child.isRunning else {
            guard let pid = serverPID, processIsRunning(pid) else { return .terminateNow }
            stopOrphanedServer(serverPID) { self.replyToTermination() }
            return .terminateLater
        }
        child.terminate()
        let deadline = DispatchWorkItem { [weak self] in
            guard let self = self else { return }
            if let pid = self.serverPID { kill(pid, SIGKILL) }
            if child.isRunning { kill(child.processIdentifier, SIGKILL) }
            self.replyToTermination()
        }
        quitDeadline = deadline; DispatchQueue.main.asyncAfter(deadline: .now() + 10, execute: deadline)
        return .terminateLater
    }
    func applicationWillTerminate(_ notification: Notification) { closing = true; quitDeadline?.cancel() }
    func isInternal(_ url: URL) -> Bool {
        url.scheme == "about" || (url.host == baseURL?.host && url.port == baseURL?.port && url.scheme == "http") || (url.scheme == "blob" && url.absoluteString.hasPrefix("blob:" + (baseURL?.absoluteString ?? "missing")))
    }
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { decisionHandler(.cancel); return }
        if isInternal(url) {
            if action.shouldPerformDownload { expectDownloadPolicyTransition(url) }
            decisionHandler(action.shouldPerformDownload ? .download : .allow)
        }
        else { if action.navigationType == .linkActivated && ["https", "http", "mailto"].contains(url.scheme ?? "") { NSWorkspace.shared.open(url) }; decisionHandler(.cancel) }
    }
    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        if response.canShowMIMEType { decisionHandler(.allow) }
        else { expectDownloadPolicyTransition(response.response.url); decisionHandler(.download) }
    }
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url { if isInternal(url) { web.load(action.request) } else if action.navigationType == .linkActivated && ["https", "http", "mailto"].contains(url.scheme ?? "") { NSWorkspace.shared.open(url) } }; return nil
    }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        guard !closing, let url = webView.url, isInternal(url) else { return }
        appendDiagnostic("页面内容进程已退出，正在重新载入当前页面。")
        webView.load(URLRequest(url: url))
    }
    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        if let navigation = navigation, let url = webView.url { provisionalNavigationURLs[ObjectIdentifier(navigation)] = url.absoluteString }
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        if isExpectedDownloadPolicyInterruption(error, navigation: navigation, webView: webView) { return }
        if let navigation = navigation { provisionalNavigationURLs.removeValue(forKey: ObjectIdentifier(navigation)) }
        let failure = error as NSError
        if failure.code != NSURLErrorCancelled && !closing {
            appendDiagnostic("页面加载失败 [\(failure.domain) \(failure.code)]：\(failure.localizedDescription)")
            showFailure("本地页面未能加载。可重试打开，详细信息见诊断日志。", retry: { [weak self] in
                guard let self = self else { return }
                if let url = self.web.url ?? self.baseURL { self.web.load(URLRequest(url: url)) } else { self.startService() }
            })
        }
    }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        if isExpectedDownloadPolicyInterruption(error, navigation: navigation, webView: webView) { return }
        if let navigation = navigation { provisionalNavigationURLs.removeValue(forKey: ObjectIdentifier(navigation)) }
        let failure = error as NSError
        if failure.code != NSURLErrorCancelled && !closing {
            appendDiagnostic("页面载入后发生错误 [\(failure.domain) \(failure.code)]：\(failure.localizedDescription)")
            showFailure("页面载入中断。可重试打开，详细信息见诊断日志。", retry: { [weak self] in
                guard let self = self else { return }
                if let url = self.web.url ?? self.baseURL { self.web.load(URLRequest(url: url)) } else { self.startService() }
            })
        }
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        if let navigation = navigation { provisionalNavigationURLs.removeValue(forKey: ObjectIdentifier(navigation)) }
    }
    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        guard !closing else { completionHandler(); return }
        let alert = NSAlert(); alert.messageText = "织识"; alert.informativeText = message
        alert.addButton(withTitle: "知道了")
        alert.beginSheetModal(for: window) { _ in completionHandler() }
    }
    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        guard !closing else { completionHandler(false); return }
        let alert = NSAlert(); alert.alertStyle = .warning; alert.messageText = "请确认操作"; alert.informativeText = message
        alert.addButton(withTitle: "确认"); alert.addButton(withTitle: "取消")
        alert.beginSheetModal(for: window) { response in completionHandler(response == .alertFirstButtonReturn) }
    }
    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        guard !closing else { completionHandler(nil); return }
        let alert = NSAlert(); alert.messageText = "织识"; alert.informativeText = prompt
        let input = NSTextField(frame: NSRect(x: 0, y: 0, width: 320, height: 24)); input.stringValue = defaultText ?? ""
        alert.accessoryView = input; alert.addButton(withTitle: "确认"); alert.addButton(withTitle: "取消")
        alert.window.initialFirstResponder = input
        alert.beginSheetModal(for: window) { response in completionHandler(response == .alertFirstButtonReturn ? input.stringValue : nil) }
    }
    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel(); panel.allowsMultipleSelection = parameters.allowsMultipleSelection; panel.canChooseDirectories = parameters.allowsDirectories; panel.canChooseFiles = true
        panel.beginSheetModal(for: window) { answer in completionHandler(answer == .OK ? panel.urls : nil) }
    }
    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { expectDownloadPolicyTransition(download.originalRequest?.url); download.delegate = self }
    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) { expectDownloadPolicyTransition(download.originalRequest?.url); download.delegate = self }
    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        let panel = NSSavePanel(); panel.nameFieldStringValue = URL(fileURLWithPath: suggestedFilename).lastPathComponent
        panel.beginSheetModal(for: window) { [weak self] answer in
            let destination = answer == .OK ? panel.url : nil
            if let destination = destination { self?.downloadDestinations[ObjectIdentifier(download)] = destination }
            completionHandler(destination)
        }
    }
    func downloadDidFinish(_ download: WKDownload) {
        clearDownloadPolicyTransition(download)
        if let destination = downloadDestinations.removeValue(forKey: ObjectIdentifier(download)) {
            window.subtitle = "已保存：\(destination.lastPathComponent)"
            DispatchQueue.main.asyncAfter(deadline: .now() + 4) { [weak self] in if self?.closing == false { self?.window.subtitle = "" } }
        }
    }
    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        clearDownloadPolicyTransition(download)
        downloadDestinations.removeValue(forKey: ObjectIdentifier(download))
        if (error as NSError).code == NSURLErrorCancelled { return }
        let failure = error as NSError
        appendDiagnostic("下载失败 [\(failure.domain) \(failure.code)]：\(failure.localizedDescription)")
        let alert = NSAlert(); alert.alertStyle = .warning; alert.messageText = "下载未完成"; alert.informativeText = "请检查保存目录的权限与剩余空间，再重新下载。"; alert.addButton(withTitle: "知道了"); alert.addButton(withTitle: "打开日志")
        alert.beginSheetModal(for: window) { [weak self] response in if response == .alertSecondButtonReturn { self?.openLogs() } }
    }
}
let app = NSApplication.shared
let delegate = AppDelegate()
app.setActivationPolicy(.regular); app.delegate = delegate; app.run()
