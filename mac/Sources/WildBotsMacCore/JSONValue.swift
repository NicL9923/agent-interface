import Foundation

/// A JSON document with exact types: a JSON `true` never reads as the number 1, and numbers keep
/// their integral check, which the argument validation relies on.
public enum JSONValue: Hashable, Sendable {
  case null
  case bool(Bool)
  case number(Double)
  case string(String)
  case array([JSONValue])
  case object([String: JSONValue])

  public static func parse(_ text: String) throws -> JSONValue {
    try JSONDecoder().decode(JSONValue.self, from: Data(text.utf8))
  }

  public subscript(key: String) -> JSONValue? {
    if case .object(let fields) = self { return fields[key] }
    return nil
  }
  public var stringValue: String? { if case .string(let value) = self { return value }; return nil }
  public var boolValue: Bool? { if case .bool(let value) = self { return value }; return nil }
  public var objectValue: [String: JSONValue]? { if case .object(let value) = self { return value }; return nil }
  public var arrayValue: [JSONValue]? { if case .array(let value) = self { return value }; return nil }
  public var doubleValue: Double? { if case .number(let value) = self { return value }; return nil }
  /// An integral number that fits in an `Int`; `1.5`, `true` and `"1"` are not integers.
  public var intValue: Int? {
    guard case .number(let value) = self, value.rounded() == value, abs(value) < 9.0e15 else { return nil }
    return Int(value)
  }

  /// Compact JSON with sorted keys. Equal values always serialize identically, so this doubles as
  /// the canonical form an invocation's fingerprint is hashed from.
  public var serialized: String {
    var out = ""
    write(into: &out)
    return out
  }

  private func write(into out: inout String) {
    switch self {
    case .null: out += "null"
    case .bool(let value): out += value ? "true" : "false"
    case .number(let value):
      if value.rounded() == value, abs(value) < 9.0e15 {
        out += String(Int64(value))
      } else if value.isFinite {
        out += "\(value)"
      } else {
        out += "null"
      }
    case .string(let value): JSONValue.writeString(value, into: &out)
    case .array(let items):
      out += "["
      for (index, item) in items.enumerated() {
        if index > 0 { out += "," }
        item.write(into: &out)
      }
      out += "]"
    case .object(let fields):
      out += "{"
      for (index, key) in fields.keys.sorted().enumerated() {
        if index > 0 { out += "," }
        JSONValue.writeString(key, into: &out)
        out += ":"
        fields[key]!.write(into: &out)
      }
      out += "}"
    }
  }

  private static func writeString(_ value: String, into out: inout String) {
    out += "\""
    for scalar in value.unicodeScalars {
      switch scalar {
      case "\"": out += "\\\""
      case "\\": out += "\\\\"
      case "\n": out += "\\n"
      case "\r": out += "\\r"
      case "\t": out += "\\t"
      case _ where scalar.value < 0x20 || scalar.value == 0x2028 || scalar.value == 0x2029:
        out += String(format: "\\u%04x", scalar.value)
      default: out.unicodeScalars.append(scalar)
      }
    }
    out += "\""
  }
}

extension JSONValue: Codable {
  public init(from decoder: Decoder) throws {
    let container = try decoder.singleValueContainer()
    if container.decodeNil() {
      self = .null
    } else if let value = try? container.decode(Bool.self) {
      self = .bool(value)
    } else if let value = try? container.decode(Double.self) {
      self = .number(value)
    } else if let value = try? container.decode(String.self) {
      self = .string(value)
    } else if let value = try? container.decode([JSONValue].self) {
      self = .array(value)
    } else {
      self = .object(try container.decode([String: JSONValue].self))
    }
  }
  public func encode(to encoder: Encoder) throws {
    var container = encoder.singleValueContainer()
    switch self {
    case .null: try container.encodeNil()
    case .bool(let value): try container.encode(value)
    case .number(let value): try container.encode(value)
    case .string(let value): try container.encode(value)
    case .array(let value): try container.encode(value)
    case .object(let value): try container.encode(value)
    }
  }
}

extension JSONValue: ExpressibleByStringLiteral, ExpressibleByBooleanLiteral, ExpressibleByIntegerLiteral,
  ExpressibleByDictionaryLiteral, ExpressibleByArrayLiteral, ExpressibleByNilLiteral
{
  public init(stringLiteral value: String) { self = .string(value) }
  public init(booleanLiteral value: Bool) { self = .bool(value) }
  public init(integerLiteral value: Int) { self = .number(Double(value)) }
  public init(dictionaryLiteral elements: (String, JSONValue)...) {
    self = .object(Dictionary(elements, uniquingKeysWith: { _, last in last }))
  }
  public init(arrayLiteral elements: JSONValue...) { self = .array(elements) }
  public init(nilLiteral: ()) { self = .null }
  public static func int(_ value: Int) -> JSONValue { .number(Double(value)) }
}
