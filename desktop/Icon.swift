import AppKit
let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 1024, pixelsHigh: 1024, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
NSGraphicsContext.saveGraphicsState(); NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
NSGraphicsContext.current!.cgContext.clear(CGRect(x: 0, y: 0, width: 1024, height: 1024))
NSColor(srgbRed: 0.12, green: 0.12, blue: 0.13, alpha: 1).setFill()
NSBezierPath(roundedRect: NSRect(x: 32, y: 32, width: 960, height: 960), xRadius: 210, yRadius: 210).fill()
NSColor(srgbRed: 0.96, green: 0.95, blue: 0.94, alpha: 1).setStroke()
// 复用组件 WeaveMark 的八段线，坐标变换后仍保留经纬交错的断点。
for points in [[5,21,8,18],[12,14,21,5],[11,27,20,18],[24,14,27,11],[5,11,14,20],[18,24,21,27],[11,5,14,8],[18,12,27,21]] {
 let line = NSBezierPath(); line.lineWidth = 70.4; line.lineCapStyle = .round
 line.move(to: NSPoint(x: CGFloat(points[0])*32, y: CGFloat(32-points[1])*32)); line.line(to: NSPoint(x: CGFloat(points[2])*32, y: CGFloat(32-points[3])*32)); line.stroke()
}
NSGraphicsContext.restoreGraphicsState()
try bitmap.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: CommandLine.arguments[1]))
