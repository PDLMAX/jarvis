import AppKit
import Foundation

// ── 配色：青蓝霓虹（与网页 HUD 一致） ──
let cyan = NSColor(calibratedRed: 0.0, green: 0.94, blue: 1.0, alpha: 1.0)

func drawIcon(size: CGFloat) {
    let s = size
    let bgPath = NSBezierPath(roundedRect: NSRect(x: 0, y: 0, width: s, height: s),
                              xRadius: s * 0.22, yRadius: s * 0.22)
    NSColor(calibratedRed: 0.015, green: 0.04, blue: 0.08, alpha: 1).setFill()
    bgPath.fill()

    let cx = s * 0.5, cy = s * 0.5

    func ring(radius: CGFloat, width: CGFloat, color: NSColor, glow: CGFloat) {
        let p = NSBezierPath(ovalIn: NSRect(x: cx - radius, y: cy - radius,
                                            width: radius * 2, height: radius * 2))
        p.lineWidth = width
        p.lineCapStyle = .round
        NSGraphicsContext.saveGraphicsState()
        let sh = NSShadow()
        sh.shadowColor = color
        sh.shadowBlurRadius = glow
        sh.shadowOffset = .zero
        sh.set()
        color.setStroke()
        p.stroke()
        NSGraphicsContext.restoreGraphicsState()
    }

    // 三层光环：外淡环 → 主光环 → 内圈
    ring(radius: s * 0.435, width: s * 0.006, color: cyan.withAlphaComponent(0.35), glow: s * 0.018)
    ring(radius: s * 0.400, width: s * 0.030, color: cyan, glow: s * 0.06)
    ring(radius: s * 0.360, width: s * 0.005, color: cyan.withAlphaComponent(0.5), glow: s * 0.015)

    // 中心三角核心（方舟反应堆）
    let triR = s * 0.16
    let tri = NSBezierPath()
    tri.move(to: NSMakePoint(cx, cy + triR))
    tri.line(to: NSMakePoint(cx - triR * 0.866, cy - triR * 0.5))
    tri.line(to: NSMakePoint(cx + triR * 0.866, cy - triR * 0.5))
    tri.close()
    NSGraphicsContext.saveGraphicsState()
    let sh = NSShadow()
    sh.shadowColor = cyan
    sh.shadowBlurRadius = s * 0.05
    sh.shadowOffset = .zero
    sh.set()
    cyan.withAlphaComponent(0.26).setFill()
    cyan.setStroke()
    tri.lineWidth = s * 0.016
    tri.lineJoinStyle = .round
    tri.fill()
    tri.stroke()
    NSGraphicsContext.restoreGraphicsState()
}

func render(size: CGFloat) -> Data {
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil,
                               pixelsWide: Int(size), pixelsHigh: Int(size),
                               bitsPerSample: 8, samplesPerPixel: 4,
                               hasAlpha: true, isPlanar: false,
                               colorSpaceName: .deviceRGB,
                               bytesPerRow: 0, bitsPerPixel: 0)!
    rep.size = NSSize(width: size, height: size)
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    drawIcon(size: size)
    NSGraphicsContext.restoreGraphicsState()
    return rep.representation(using: .png, properties: [:])!
}

let fm = FileManager.default
let iconset = "AppIcon.iconset"
try? fm.createDirectory(atPath: iconset, withIntermediateDirectories: true)

// (尺寸, 输出文件名列表)
let sizes: [(CGFloat, [String])] = [
    (16,   ["icon_16x16.png"]),
    (32,   ["icon_16x16@2x.png", "icon_32x32.png"]),
    (64,   ["icon_32x32@2x.png"]),
    (128,  ["icon_128x128.png"]),
    (256,  ["icon_128x128@2x.png", "icon_256x256.png"]),
    (512,  ["icon_256x256@2x.png", "icon_512x512.png"]),
    (1024, ["icon_512x512@2x.png"]),
]

for (size, names) in sizes {
    let data = render(size: size)
    for name in names {
        try? data.write(to: URL(fileURLWithPath: "\(iconset)/\(name)"))
    }
}

let p = Process()
p.executableURL = URL(fileURLWithPath: "/usr/bin/iconutil")
p.arguments = ["-c", "icns", iconset, "-o", "AppIcon.icns"]
try? p.run()
p.waitUntilExit()

try? fm.removeItem(atPath: iconset)
print("✅ AppIcon.icns 已生成")
