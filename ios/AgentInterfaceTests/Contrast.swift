import SwiftUI
import UIKit

/// WCAG contrast between colors as the app draws them, for tests that hold palette colors to 4.5:1 for text
/// and 3:1 for marks.
enum Contrast {
  typealias RGBA = (r: Double, g: Double, b: Double, a: Double)
  /// The traits a color resolves under: light or dark, and optionally an elevated surface, such as a sheet in
  /// dark, or Increase Contrast.
  static func traits(dark: Bool, elevated: Bool = false, increased: Bool = false) -> UITraitCollection {
    UITraitCollection(mutations: { traits in
      traits.userInterfaceStyle = dark ? .dark : .light
      traits.userInterfaceLevel = elevated ? .elevated : .base
      traits.accessibilityContrast = increased ? .high : .normal
    })
  }
  /// A color as one appearance draws it, with its alpha.
  static func resolved(_ color: Color, dark: Bool, elevated: Bool = false, increased: Bool = false) -> RGBA {
    resolved(UIColor(color), dark: dark, elevated: elevated, increased: increased)
  }
  static func resolved(_ color: UIColor, dark: Bool, elevated: Bool = false, increased: Bool = false) -> RGBA {
    let ui = color.resolvedColor(with: traits(dark: dark, elevated: elevated, increased: increased))
    var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
    ui.getRed(&r, green: &g, blue: &b, alpha: &a)
    return (Double(r), Double(g), Double(b), Double(a))
  }
  /// `top` at `opacity` (times its own alpha) over an opaque `bottom`, as 0...1 channels.
  static func over(_ top: RGBA, _ bottom: RGBA, opacity: Double = 1) -> RGBA {
    let a = top.a * opacity
    return (top.r * a + bottom.r * (1 - a), top.g * a + bottom.g * (1 - a), top.b * a + bottom.b * (1 - a), 1)
  }
  static func luminance(_ c: RGBA) -> Double {
    func linear(_ v: Double) -> Double { v <= 0.04045 ? v / 12.92 : pow((v + 0.055) / 1.055, 2.4) }
    return 0.2126 * linear(c.r) + 0.7152 * linear(c.g) + 0.0722 * linear(c.b)
  }
  static func ratio(_ x: RGBA, _ y: RGBA) -> Double {
    let (l1, l2) = (luminance(x), luminance(y))
    return (max(l1, l2) + 0.05) / (min(l1, l2) + 0.05)
  }
}
