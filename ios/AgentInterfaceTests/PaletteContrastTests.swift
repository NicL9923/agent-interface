import SwiftUI
import UIKit
import XCTest
@testable import AgentInterface

/// The palette's status colors on every fill the app puts them on, in light and dark. Text needs 4.5:1; a dot,
/// stripe, ring or icon that carries meaning needs 3:1. A palette change that lowers one fails here.
@MainActor final class PaletteContrastTests: XCTestCase {
  /// A fill the app draws, as a function of the appearance, so system colors resolve as the screen does.
  private struct Fill {
    var name: String
    var color: (_ dark: Bool) -> Contrast.RGBA
    static func palette(_ name: String, _ color: Color) -> Fill { Fill(name: name) { Contrast.resolved(color, dark: $0) } }
    static func scheme(_ name: String, _ color: @escaping (ColorScheme) -> Color) -> Fill {
      Fill(name: name) { Contrast.resolved(color($0 ? .dark : .light), dark: $0) }
    }
    /// A system color, on a base surface and, as in a sheet, an elevated one.
    static func system(_ name: String, _ color: UIColor, elevated: Bool = false, increased: Bool = false) -> Fill {
      Fill(name: name) { Contrast.resolved(color, dark: $0, elevated: elevated, increased: increased) }
    }
    /// `top` at `opacity` over `bottom`.
    static func mix(_ name: String, _ top: Color, _ opacity: Double, over bottom: Fill) -> Fill {
      Fill(name: name) { Contrast.over(Contrast.resolved(top, dark: $0), bottom.color($0), opacity: opacity) }
    }
  }
  private static let surface = Fill.scheme("surface", Palette.surface)
  private static let raised = Fill.scheme("raised card or row", Palette.raised)
  private static let rail = Fill.scheme("rail, the iPad home column", Palette.rail)
  private static let selected = Fill.palette("soft accent, a selected row", Palette.accentSoft)
  /// Settings, the Work list and assistant profiles leave rows on the system's grouped row color, which a sheet
  /// raises in dark and Increase Contrast changes.
  private static let systemRows: [Fill] = [false, true].flatMap { elevated in
    [false, true].map { increased in
      Fill.system("system grouped row\(elevated ? ", elevated" : "")\(increased ? ", Increase Contrast" : "")",
        .secondarySystemGroupedBackground, elevated: elevated, increased: increased)
    }
  }
  /// What a List row shows while a finger is on it: UIKit's own list cell background in its highlighted state.
  private static let pressedSystemRow = Fill(name: "a pressed list row") { dark in
    var state = UICellConfigurationState(traitCollection: Contrast.traits(dark: dark))
    state.isHighlighted = true
    let highlight = UIBackgroundConfiguration.listGroupedCell().updated(for: state)
    return Contrast.resolved(highlight.backgroundColor ?? .systemGray4, dark: dark)
  }

  private func check(_ ink: Color, _ uses: [(String, [Fill], Double)], file: StaticString = #filePath, line: UInt = #line) {
    for dark in [false, true] {
      for (use, fills, minimum) in uses {
        for fill in fills {
          let background = fill.color(dark)
          let value = Contrast.ratio(Contrast.over(Contrast.resolved(ink, dark: dark), background), background)
          XCTAssertGreaterThanOrEqual(value, minimum, "\(use) on \(fill.name) in \(dark ? "dark" : "light"): \(String(format: "%.2f", value)):1",
            file: file, line: line)
        }
      }
    }
  }

  /// Every place the attention color is text or a mark. The Today row and the status dock gained fills of their
  /// own so their text keeps 4.5:1 there: `AttentionRowStyle` and the dock's card.
  func testAttentionKeepsItsContrastOnEveryFillItSitsOn() {
    let homeRows = [Self.surface, Self.rail, Self.selected,
      Fill.mix("main assistant row on the phone home", Palette.accentSoft, 0.45, over: Self.surface),
      Fill.mix("main assistant row on the iPad home", Palette.accentSoft, 0.45, over: Self.rail)]
    let todayPressed = Fill.mix("a pressed Today row", Palette.accentSoft, AttentionRowStyle.pressedOpacity, over: Self.raised)
    let terminalBar = Fill.mix("the terminal's bar", Color.primary, 0.06, over: Self.surface)
    check(Palette.attention, [
      ("Settings notifications: Blocked and its notice", [Self.raised], 4.5),
      ("a request card's caption, its connection, handoff and terminal errors, and an integration error in it", [Self.raised], 4.5),
      ("an approval's Your decision needed", [Self.raised], 4.5),
      ("a Today attention reason", [Self.raised, todayPressed], 4.5),
      ("Hermes updates: the busy message", Self.systemRows, 4.5),
      ("a Work task's Blocked line", Self.systemRows, 4.5),
      ("a routine run's status word", [Self.raised], 4.5),
      ("an assistant's activity on home", homeRows, 4.5),
      ("an assistant's activity in its profile", Self.systemRows, 4.5),
      ("an integration's status", Self.systemRows, 4.5),
      ("the computer's notice and the terminal's", [Self.surface, terminalBar], 4.5),
      ("the status dock's refused and interrupted lines", [Self.raised], 4.5),
      ("an approval or request card's stripe", [Self.raised, Self.surface], 3),
      ("the Hermes row's dot in Settings", [Self.raised, Self.pressedSystemRow], 3),
      ("a routine run's dot", [Self.raised], 3),
      ("home's reconnecting dot, inside its ring", [Self.surface, Self.rail], 3),
      ("an avatar's blocked ring and badge", homeRows, 3),
      ("a goal callout's symbol and the dock's icons", Self.systemRows + [Self.raised], 3),
      ("the usage bar at its warning level", [Self.raised, Fill.mix("its track", Color(uiColor: .systemFill), 1, over: Self.raised)], 3),
    ])
    // The avatar's blocked badge draws a glyph in the surface color on the attention fill.
    for dark in [false, true] {
      let badge = Contrast.resolved(Palette.attention, dark: dark), glyph = Contrast.resolved(Palette.surface(dark ? .dark : .light), dark: dark)
      XCTAssertGreaterThanOrEqual(Contrast.ratio(glyph, badge), 3, "The blocked badge's glyph in \(dark ? "dark" : "light")")
    }
  }
}
