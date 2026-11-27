import SwiftUI

/// Functional-layer Liquid Glass helpers (iOS 26+) and native Zoom Transition helpers (iOS 18+).
/// Liquid Glass is applied strictly to the functional chrome layer (floating composer, controls,
/// status dock, jump pill, computer bar) while keeping the transcript content layer crisp and opaque.
extension View {
  /// A control floating over content: Liquid Glass on iOS 26+, and a material with a hairline edge
  /// on iOS 17–25. Both adapt automatically to Reduce Transparency.
  @ViewBuilder func glassSurface<S: Shape>(_ shape: S, interactive: Bool = false) -> some View {
    if #available(iOS 26, *) {
      glassEffect(interactive ? .regular.interactive() : .regular, in: shape)
    } else {
      background(.regularMaterial, in: shape).overlay(shape.stroke(Palette.line, lineWidth: 1))
    }
  }

  /// Groups sibling Liquid Glass controls into a shared `GlassEffectContainer` on iOS 26+ so their
  /// glass surfaces blend and morph cleanly during transitions.
  @ViewBuilder func glassContainer(spacing: CGFloat = 8) -> some View {
    if #available(iOS 26, *) {
      GlassEffectContainer(spacing: spacing) { self }
    } else {
      self
    }
  }

  /// Marks a thumbnail, pinned tile, or header button as the origin of a native zoom transition
  /// on iOS 18+ when a namespace is active.
  @ViewBuilder func zoomSource<ID: Hashable>(id: ID, in namespace: Namespace.ID?) -> some View {
    if #available(iOS 18, *), let namespace {
      matchedTransitionSource(id: id, in: namespace)
    } else {
      self
    }
  }

  /// Applies the matching zoom navigation/sheet transition on iOS 18+ when both source ID and
  /// namespace are present.
  @ViewBuilder func zoomTransition<ID: Hashable>(sourceID: ID?, in namespace: Namespace.ID?) -> some View {
    if #available(iOS 18, *), let sourceID, let namespace {
      navigationTransition(.zoom(sourceID: sourceID, in: namespace))
    } else {
      self
    }
  }
}

private struct ZoomNamespaceKey: EnvironmentKey {
  static let defaultValue: Namespace.ID? = nil
}

extension EnvironmentValues {
  /// Shared zoom namespace connecting attachment thumbnails in the transcript to the root preview sheet.
  var zoomNamespace: Namespace.ID? {
    get { self[ZoomNamespaceKey.self] }
    set { self[ZoomNamespaceKey.self] = newValue }
  }
}
