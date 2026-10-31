import AppKit
import CoreGraphics
import Foundation

let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
let target = windows.first { item in
    let owner = (item[kCGWindowOwnerName as String] as? String ?? "").lowercased()
    let title = (item[kCGWindowName as String] as? String ?? "").lowercased()
    return owner.contains("my-browser") || title == "unky"
}
guard let number = target?[kCGWindowNumber as String] as? Int else {
    fputs("Could not find the visible Unky native window.\n", stderr)
    exit(2)
}
print(number)
