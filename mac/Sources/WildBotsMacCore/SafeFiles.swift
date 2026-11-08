import CryptoKit
import Darwin
import Foundation

/// A granted folder held open by descriptor. File actions walk from this descriptor one
/// component at a time, so renaming a folder above it or swapping a path component for a
/// symbolic link cannot redirect an action outside it.
public final class FolderHandle: @unchecked Sendable {
  public let name: String
  public let path: String
  let components: [String]
  let fd: Int32
  private let device: dev_t
  private let inode: ino_t

  /// Opens the folder from `/` one component at a time with `O_NOFOLLOW`. A symbolic link
  /// anywhere in the path is refused, not only at its end: with overlapping folders an assistant
  /// could otherwise swap an ancestor it can write for a link to somewhere it was never given.
  public init(name: String, path: String) throws {
    self.name = name
    self.path = path
    components = pathComponents(path)
    let descriptor: Int32
    do {
      descriptor = try Self.openWithoutLinks(components)
    } catch let refusal as FolderOpenRefusal {
      throw ActionError(.notFound, "The folder \(ActionError.quoted(path)) could not be opened: \(refusal.reason).")
    }
    var info = stat()
    fstat(descriptor, &info)
    fd = descriptor
    device = info.st_dev
    inode = info.st_ino
  }
  deinit { close(fd) }

  /// Refuses when the folder was moved or replaced since it was granted, including when a folder
  /// above it became a symbolic link. The command sandbox confines by path, so file actions must
  /// agree with that path, not follow the old directory.
  func verify() throws {
    var current = stat()
    let descriptor = try? Self.openWithoutLinks(components)
    defer { if let descriptor { close(descriptor) } }
    guard let descriptor, fstat(descriptor, &current) == 0, current.st_dev == device, current.st_ino == inode else {
      throw ActionError(.notFound, "The folder \(ActionError.quoted(path)) was moved or replaced. Add it again in WildBots.")
    }
  }

  struct FolderOpenRefusal: Error { var reason: String }

  /// Walks `components` from `/` with `openat` and `O_NOFOLLOW | O_DIRECTORY` on every step.
  static func openWithoutLinks(_ components: [String]) throws -> Int32 {
    var current = open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC)
    guard current >= 0 else { throw FolderOpenRefusal(reason: String(cString: strerror(errno))) }
    var walked = ""
    for component in components {
      walked += "/" + component
      let next = openat(current, component, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
      if next < 0 {
        let code = errno
        var info = stat()
        let isLink = fstatat(current, component, &info, AT_SYMLINK_NOFOLLOW) == 0 && (info.st_mode & S_IFMT) == S_IFLNK
        close(current)
        throw FolderOpenRefusal(
          reason: isLink || code == ELOOP
            ? "\(ActionError.quoted(walked)) is a symbolic link" : String(cString: strerror(code)).lowercased())
      }
      close(current)
      current = next
    }
    return current
  }
}

/// A requested path split into the granted folder that contains it and the components below it.
public struct ResolvedPath: Equatable {
  public var folder: String
  public var relative: [String]
  public var absolute: String { ([folder] + relative).joined(separator: "/") }
  /// The absolute path shortened for quoting in an error message.
  public var display: String { ActionError.quoted(absolute) }
}

public enum PathResolver {
  /// Turns a requested path into its folder and components without touching the disk.
  /// Absolute paths and `~/` paths are used as given; anything else is relative to the first folder.
  public static func resolve(_ raw: String, folders: [FolderHandle], home: String) throws -> (FolderHandle, ResolvedPath) {
    guard let first = folders.first else {
      throw ActionError(.outsideFolders, "No folders are shared with assistants on this Mac.")
    }
    let absolute: String
    if raw == "~" || raw.hasPrefix("~/") {
      absolute = home + raw.dropFirst()
    } else if raw.hasPrefix("~") {
      throw ActionError(.outsideFolders, "Only your own home folder can be named with ~.")
    } else if raw.hasPrefix("/") {
      absolute = raw
    } else {
      absolute = first.path + "/" + raw
    }
    var components: [String] = []
    for part in pathComponents(absolute) where part != "." {
      if part == ".." {
        _ = components.popLast()
      } else {
        components.append(part)
      }
    }
    if let pattern = ProtectedPaths.match(components) {
      throw ActionError(.protectedPath, "\(ActionError.quoted(pattern.joined(separator: "/"))) is protected and never shared with assistants.")
    }
    let containing = folders.filter {
      components.count >= $0.components.count && Array(components.prefix($0.components.count)) == $0.components
    }
    guard let folder = containing.max(by: { $0.components.count < $1.components.count }) else {
      throw ActionError(.outsideFolders, "\(ActionError.quoted("/" + components.joined(separator: "/"))) is outside the folders shared on this Mac.")
    }
    return (folder, ResolvedPath(folder: folder.path, relative: Array(components.dropFirst(folder.components.count))))
  }
}

/// File actions on granted folders. Every call opens from the folder descriptor with
/// `O_NOFOLLOW` per component, refuses symbolic links, special files and files with more than
/// one hard link, and writes through a temporary file renamed into place.
public enum SafeFiles {
  /// Hashing a whole file is the cost of `read_file` and of a versioned write; bigger files are
  /// refused before any of it is read.
  public static let maxHashedFileSize: Int64 = 1 << 30

  /// What a file action answers when Pause or Unlink stopped it before it finished.
  static let stopped = ActionError(.paused, "The action was stopped because assistants were paused or this Mac was unlinked.")

  // MARK: Actions

  public static func readFile(
    folder: FolderHandle, path: ResolvedPath, offset: Int, length: Int, cancel: CancellationFlag? = nil
  ) throws -> JSONValue {
    try folder.verify()
    guard let name = path.relative.last else { throw ActionError(.notAFile, "\(path.display) is a folder.") }
    let parent = try openParent(folder, path)
    defer { close(parent) }
    let fd = try openRegularFile(parent, name, display: path.display)
    defer { close(fd) }
    var info = stat()
    fstat(fd, &info)
    let size = Int64(info.st_size)
    guard Int64(offset) <= size else {
      throw ActionError(.invalidArguments, "offset \(offset) is past the end of the file (\(size) bytes).")
    }
    let digest = try sha256(fd: fd, size: size, display: path.display, cancel: cancel)
    let count = Int(min(Int64(length), size - Int64(offset)))
    var slice = Data(count: count)
    if count > 0 {
      let read = slice.withUnsafeMutableBytes { pread(fd, $0.baseAddress, count, off_t(offset)) }
      guard read == count else { throw ActionError(.failed, "\(path.display) changed while it was read.") }
    }
    let text = String(data: slice, encoding: .utf8)
    return [
      "path": .string(path.absolute), "size": .int(Int(size)), "sha256": .string(digest), "offset": .int(offset),
      "encoding": text == nil ? "base64" : "utf8", "content": .string(text ?? slice.base64EncodedString()),
      "eof": .bool(Int64(offset + count) >= size),
    ]
  }

  /// Writes through a temporary file in the same folder, renamed over the target.
  ///
  /// Writes from this app to one file take turns (`WriteTurns`), and the version check, the
  /// temporary file and the rename all happen in one turn, so two versioned writes that expect
  /// the same version cannot both succeed. A process outside this app that changes the file
  /// between the hash and the rename is not fenced: POSIX has no compare-and-swap rename, and
  /// swapping the file out to inspect it would lose that process's newer content instead.
  public static func writeFile(
    folder: FolderHandle, path: ResolvedPath, content: Data, expectedSha256: String?, createOnly: Bool,
    cancel: CancellationFlag? = nil
  ) throws -> JSONValue {
    try folder.verify()
    guard let name = path.relative.last else { throw ActionError(.notAFile, "\(path.display) is a folder.") }
    let parent = try openParent(folder, path)
    defer { close(parent) }
    var parentInfo = stat()
    guard fstat(parent, &parentInfo) == 0 else { throw posixError(errno, display: path.display) }
    // One turn per folder, not per name: APFS folds case and Unicode its own way (Σ and ς name
    // one file), so no key built from the name can be sure two names are different files.
    let key = "\(parentInfo.st_dev):\(parentInfo.st_ino)"
    return try WriteTurns.shared.take(key) {
      try writeInTurn(parent: parent, name: name, path: path, content: content, expectedSha256: expectedSha256,
        createOnly: createOnly, cancel: cancel)
    }
  }

  private static func writeInTurn(
    parent: Int32, name: String, path: ResolvedPath, content: Data, expectedSha256: String?, createOnly: Bool,
    cancel: CancellationFlag?
  ) throws -> JSONValue {
    var existing = stat()
    let exists: Bool
    if fstatat(parent, name, &existing, AT_SYMLINK_NOFOLLOW) == 0 {
      exists = true
      if createOnly { throw ActionError(.exists, "\(path.display) already exists.") }
      try checkReplaceable(existing, display: path.display)
      if let expectedSha256 {
        let fd = try openRegularFile(parent, name, display: path.display)
        defer { close(fd) }
        var info = stat()
        fstat(fd, &info)
        guard try sha256(fd: fd, size: Int64(info.st_size), display: path.display, cancel: cancel) == expectedSha256 else {
          throw ActionError(.conflict, "\(path.display) has changed since that version.")
        }
      }
    } else if errno == ENOENT {
      exists = false
      if expectedSha256 != nil {
        throw ActionError(.conflict, "\(path.display) no longer exists, so that version cannot be replaced.")
      }
    } else {
      throw posixError(errno, display: path.display)
    }

    let temp = ".wildbots-write-\(UUID().uuidString)"
    let mode = exists ? mode_t(existing.st_mode & 0o777) : 0o644
    let tempFd = openat(parent, temp, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, mode)
    guard tempFd >= 0 else { throw posixError(errno, display: path.display) }
    var renamed = false
    defer { if !renamed { unlinkat(parent, temp, 0) } }
    do {
      defer { close(tempFd) }
      try content.withUnsafeBytes { buffer in
        var written = 0
        while written < buffer.count {
          let result = write(tempFd, buffer.baseAddress! + written, buffer.count - written)
          if result < 0 {
            if errno == EINTR { continue }
            throw posixError(errno, display: path.display)
          }
          written += result
        }
      }
      fchmod(tempFd, mode)
      guard fsync(tempFd) == 0 else { throw posixError(errno, display: path.display) }
    }

    // Last point where Pause or Unlink can still keep the write from happening.
    if cancel?.isCancelled == true { throw stopped }
    if !exists {
      guard renameatx_np(parent, temp, parent, name, UInt32(RENAME_EXCL)) == 0 else {
        throw errno == EEXIST
          ? ActionError(.exists, "\(path.display) was created by something else at the same time.")
          : posixError(errno, display: path.display)
      }
    } else {
      guard renameat(parent, temp, parent, name) == 0 else { throw posixError(errno, display: path.display) }
    }
    renamed = true
    fsync(parent)
    let digest = SHA256.hash(data: content).map { String(format: "%02x", $0) }.joined()
    return [
      "path": .string(path.absolute), "size": .int(content.count), "sha256": .string(digest), "created": .bool(!exists),
    ]
  }

  public static func listDir(
    folder: FolderHandle, path: ResolvedPath, offset: Int, limit: Int, cancel: CancellationFlag? = nil
  ) throws -> JSONValue {
    try folder.verify()
    let directory: Int32
    if let name = path.relative.last {
      let parent = try openParent(folder, path)
      defer { close(parent) }
      directory = try openDirectory(parent, name, display: path.display)
    } else {
      directory = dup(folder.fd)
    }
    defer { close(directory) }
    let names = try entryNames(directory, display: path.display)
    guard offset <= names.count else {
      throw ActionError(.invalidArguments, "offset \(offset) is past the end of the listing (\(names.count) entries).")
    }
    let formatter = ISO8601DateFormatter()
    var entries: [JSONValue] = []
    for name in names[offset..<min(names.count, offset + limit)] {
      if cancel?.isCancelled == true { throw stopped }
      var info = stat()
      guard fstatat(directory, name, &info, AT_SYMLINK_NOFOLLOW) == 0 else { continue }
      let type: String
      switch info.st_mode & S_IFMT {
      case S_IFREG: type = "file"
      case S_IFDIR: type = "dir"
      case S_IFLNK: type = "link"
      default: type = "other"
      }
      let modified = Date(
        timeIntervalSince1970: TimeInterval(info.st_mtimespec.tv_sec) + TimeInterval(info.st_mtimespec.tv_nsec) / 1e9)
      entries.append([
        "name": .string(name), "type": .string(type), "size": .int(Int(info.st_size)),
        "modified": .string(formatter.string(from: modified)),
      ])
    }
    var result: [String: JSONValue] = [
      "path": .string(path.absolute), "entries": .array(entries), "total": .int(names.count),
    ]
    if offset + limit < names.count { result["nextOffset"] = .int(offset + limit) }
    return .object(result)
  }

  // MARK: Descriptor walking

  /// Opens the directory that holds the last component, walking from the folder descriptor.
  static func openParent(_ folder: FolderHandle, _ path: ResolvedPath) throws -> Int32 {
    var current = dup(folder.fd)
    guard current >= 0 else { throw posixError(errno, display: path.display) }
    var walked = folder.path
    for component in path.relative.dropLast() {
      walked += "/" + component
      let next: Int32
      do {
        next = try openDirectory(current, component, display: ActionError.quoted(walked))
      } catch {
        close(current)
        throw error
      }
      close(current)
      current = next
    }
    return current
  }

  static func openDirectory(_ parent: Int32, _ name: String, display: String) throws -> Int32 {
    var info = stat()
    guard fstatat(parent, name, &info, AT_SYMLINK_NOFOLLOW) == 0 else { throw posixError(errno, display: display) }
    switch info.st_mode & S_IFMT {
    case S_IFDIR: break
    case S_IFLNK: throw symlinkRefusal(display)
    default: throw ActionError(.notADirectory, "\(display) is not a folder.")
    }
    let fd = openat(parent, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
    guard fd >= 0 else {
      throw errno == ELOOP ? symlinkRefusal(display) : posixError(errno, display: display)
    }
    return fd
  }

  /// Opens a regular file with a single link. `O_NONBLOCK` keeps a FIFO swapped in after the
  /// check from blocking the open; the descriptor is checked again after opening.
  static func openRegularFile(_ parent: Int32, _ name: String, display: String) throws -> Int32 {
    var info = stat()
    guard fstatat(parent, name, &info, AT_SYMLINK_NOFOLLOW) == 0 else { throw posixError(errno, display: display) }
    try checkReplaceable(info, display: display)
    let fd = openat(parent, name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
    guard fd >= 0 else { throw errno == ELOOP ? symlinkRefusal(display) : posixError(errno, display: display) }
    var opened = stat()
    fstat(fd, &opened)
    do {
      try checkReplaceable(opened, display: display)
      guard opened.st_ino == info.st_ino, opened.st_dev == info.st_dev else {
        throw ActionError(.failed, "\(display) changed while it was opened.")
      }
    } catch {
      close(fd)
      throw error
    }
    return fd
  }

  static func checkReplaceable(_ info: stat, display: String) throws {
    switch info.st_mode & S_IFMT {
    case S_IFREG: break
    case S_IFLNK: throw symlinkRefusal(display)
    case S_IFDIR: throw ActionError(.notAFile, "\(display) is a folder.")
    default: throw ActionError(.notAFile, "\(display) is not a regular file.")
    }
    guard info.st_nlink <= 1 else {
      throw ActionError(.hardLink, "\(display) has more than one hard link, and another name for it may be outside your folders.")
    }
  }

  static func entryNames(_ directory: Int32, display: String) throws -> [String] {
    let copy = dup(directory)
    guard copy >= 0, let stream = fdopendir(copy) else { throw posixError(errno, display: display) }
    defer { closedir(stream) }
    // A duplicated descriptor shares its directory offset with the folder's own descriptor, so
    // an earlier listing leaves it at the end. Start from the top every time.
    rewinddir(stream)
    var names: [String] = []
    while let entry = readdir(stream) {
      let name = withUnsafePointer(to: entry.pointee.d_name) {
        $0.withMemoryRebound(to: CChar.self, capacity: Int(entry.pointee.d_namlen) + 1) { String(cString: $0) }
      }
      if name != "." && name != ".." { names.append(name) }
    }
    return names.sorted()
  }

  /// Hashes exactly the first `size` bytes, the size the caller validated. Refuses a file over
  /// `maxHashedFileSize` before reading any of it, stops between chunks when cancelled, and
  /// refuses a file whose size changed while it was read.
  static func sha256(fd: Int32, size: Int64, display: String, cancel: CancellationFlag? = nil) throws -> String {
    guard size <= maxHashedFileSize else { throw ActionError(.tooLarge, "\(display) is larger than 1 GiB.") }
    var hasher = SHA256()
    var buffer = [UInt8](repeating: 0, count: 1 << 20)
    var position: Int64 = 0
    while position < size {
      if cancel?.isCancelled == true { throw stopped }
      let want = Int(min(Int64(buffer.count), size - position))
      let count = buffer.withUnsafeMutableBytes { pread(fd, $0.baseAddress, want, off_t(position)) }
      if count < 0 {
        if errno == EINTR { continue }
        throw posixError(errno, display: display)
      }
      if count == 0 { throw ActionError(.conflict, "\(display) got shorter while it was being read.") }
      hasher.update(data: buffer[0..<count])
      position += Int64(count)
    }
    var after = stat()
    guard fstat(fd, &after) == 0, Int64(after.st_size) == size else {
      throw ActionError(.conflict, "\(display) changed size while it was being read.")
    }
    return hasher.finalize().map { String(format: "%02x", $0) }.joined()
  }

  static func symlinkRefusal(_ display: String) -> ActionError {
    ActionError(.outsideFolders, "\(display) is a symbolic link. WildBots does not follow links, which could lead outside your folders.")
  }

  static func posixError(_ code: Int32, display: String) -> ActionError {
    switch code {
    case ENOENT: return ActionError(.notFound, "\(display) does not exist.")
    case ENOTDIR: return ActionError(.notADirectory, "A part of \(display) is not a folder.")
    case EISDIR: return ActionError(.notAFile, "\(display) is a folder.")
    case ELOOP: return symlinkRefusal(display)
    case EACCES, EPERM:
      return ActionError(.failed, "macOS denied access to \(display). It may need Files and Folders permission for WildBots in System Settings.")
    case ENOSPC: return ActionError(.failed, "The disk is full.")
    case ENAMETOOLONG: return ActionError(.invalidArguments, "\(display) is too long.")
    default: return ActionError(.failed, "\(display): \(String(cString: strerror(code))).")
    }
  }
}

/// Lets writes from this app to one file take turns, so a version check and the rename that
/// depends on it are never interleaved with another write from this app.
final class WriteTurns: @unchecked Sendable {
  static let shared = WriteTurns()
  private let condition = NSCondition()
  private var busy: Set<String> = []

  func take<T>(_ key: String, _ body: () throws -> T) throws -> T {
    condition.lock()
    while busy.contains(key) { condition.wait() }
    busy.insert(key)
    condition.unlock()
    defer {
      condition.lock()
      busy.remove(key)
      condition.broadcast()
      condition.unlock()
    }
    return try body()
  }
}
