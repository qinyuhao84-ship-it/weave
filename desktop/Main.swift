import Cocoa
import WebKit

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate {
    var window: NSWindow!
    var web: WKWebView!
    var process: Process?
    var baseURL: URL?
    var buffer = ""
    var closing = false
    var terminationSignal: DispatchSourceSignal?
    func applicationDidFinishLaunching(_ notification: Notification) {
        if let previous = NSRunningApplication.runningApplications(withBundleIdentifier: Bundle.main.bundleIdentifier!).first(where: { $0.processIdentifier != ProcessInfo.processInfo.processIdentifier }) {
            previous.activate(options: [.activateAllWindows]); NSApp.terminate(nil); return
        }
        signal(SIGTERM, SIG_IGN)
        terminationSignal = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
        terminationSignal?.setEventHandler { NSApp.terminate(nil) }
        terminationSignal?.resume()
        installMenus()
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1200, height: 800), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "织识"; window.minSize = NSSize(width: 860, height: 600); window.center()
        web = WKWebView(frame: window.contentView!.bounds)
        web.autoresizingMask = [.width, .height]; web.navigationDelegate = self; web.uiDelegate = self
        window.contentView!.addSubview(web)
        web.loadHTMLString("<html lang='zh'><body style='font:18px system-ui;padding:40px'>正在打开织识…</body></html>", baseURL: nil)
        window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true)
        let resources = Bundle.main.resourceURL!
        let child = Process(); child.executableURL = resources.appendingPathComponent("runtime/bin/node")
        child.arguments = [resources.appendingPathComponent("launcher.mjs").path]
        let output = Pipe(); child.standardOutput = output; child.standardError = Pipe()
        output.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData; guard !data.isEmpty, let text = String(data: data, encoding: .utf8) else { return }
            DispatchQueue.main.async {
                guard let self = self else { return }; self.buffer += text
                guard let line = self.buffer.split(separator: "\n").first, let bytes = String(line).data(using: .utf8), let record = try? JSONSerialization.jsonObject(with: bytes) as? [String: String], let address = record["url"], let url = URL(string: address), url.host == "127.0.0.1" else { return }
                self.baseURL = url; self.web.load(URLRequest(url: url)); output.fileHandleForReading.readabilityHandler = nil
            }
        }
        child.terminationHandler = { [weak self] _ in DispatchQueue.main.async {
            guard let self = self, !self.closing else { return }; self.showFailure("本地服务停止。请重新打开织识；日志在应用支持目录的 desktop.log 中。")
        } }
        process = child
        do { try child.run() } catch { showFailure("无法启动随应用提供的运行时。请重新下载安装包。") }
    }
    func installMenus() {
        let menu = NSMenu(); let appItem = NSMenuItem(); menu.addItem(appItem)
        let appMenu = NSMenu(); appMenu.addItem(withTitle: "关于织识", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator()); appMenu.addItem(withTitle: "退出织识", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"); appItem.submenu = appMenu
        let editItem = NSMenuItem(); menu.addItem(editItem); let edit = NSMenu(title: "编辑")
        for (title, selector, key) in [("撤销", "undo:", "z"), ("剪切", "cut:", "x"), ("复制", "copy:", "c"), ("粘贴", "paste:", "v"), ("全选", "selectAll:", "a")] { edit.addItem(withTitle: title, action: Selector(selector), keyEquivalent: key) }
        editItem.submenu = edit; NSApp.mainMenu = menu
    }
    func showFailure(_ text: String) { let alert = NSAlert(); alert.messageText = "织识未能打开"; alert.informativeText = text; alert.runModal(); NSApp.terminate(nil) }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
    func applicationWillTerminate(_ notification: Notification) { closing = true; if process?.isRunning == true { process?.terminate() } }
    func isInternal(_ url: URL) -> Bool { url.scheme == "about" || (url.host == baseURL?.host && url.port == baseURL?.port && url.scheme == "http") || (url.scheme == "blob" && url.absoluteString.hasPrefix("blob:" + (baseURL?.absoluteString ?? "missing"))) }
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { decisionHandler(.cancel); return }
        if isInternal(url) { decisionHandler(action.shouldPerformDownload ? .download : .allow) }
        else { if action.navigationType == .linkActivated && ["https", "http", "mailto"].contains(url.scheme ?? "") { NSWorkspace.shared.open(url) }; decisionHandler(.cancel) }
    }
    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) { decisionHandler(response.canShowMIMEType ? .allow : .download) }
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url { if isInternal(url) { web.load(action.request) } else if action.navigationType == .linkActivated && ["https", "http", "mailto"].contains(url.scheme ?? "") { NSWorkspace.shared.open(url) } }; return nil
    }
    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel(); panel.allowsMultipleSelection = parameters.allowsMultipleSelection; panel.canChooseDirectories = parameters.allowsDirectories; panel.canChooseFiles = true
        completionHandler(panel.runModal() == .OK ? panel.urls : nil)
    }
    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { download.delegate = self }
    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) { download.delegate = self }
    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) { let panel = NSSavePanel(); panel.nameFieldStringValue = suggestedFilename; completionHandler(panel.runModal() == .OK ? panel.url : nil) }
}
let app = NSApplication.shared
let delegate = AppDelegate()
app.setActivationPolicy(.regular); app.delegate = delegate; app.run()
