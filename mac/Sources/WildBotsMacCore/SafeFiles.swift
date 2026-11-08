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

  public init(name: String, path: String) throws {
    self.name = name
    self.path = path
    components = pathComponents(path)
    let descriptor = open(path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
    guard descriptor >= 0 else {
      throw ActionError(.notFound, "The folder \(path) could not be opened (\(String(cString: strerror(errno)))).")
    }
    var info = stat()
    fstat(descriptor, &info)
    fd = descriptor
    device = info.st_dev
    inode = info.st_ino
  }
  deinit { close(fd) }

  /// Refuses when the folder was moved or replaced since it was granted. The command sandbox
  /// confines by path, so file actions must agree with that path, not follow the old directory.
  func verify() throws {
    var current = stat()
    guard lstat(path, &current) == 0, (current.st_mode & S_IFMT) == S_IFDIR, current.st_dev == device,
      current.st_ino == inode
    else {
      throw ActionError(.notFound, "The folder \(path) was moved or replaced. Add it again in WildBots.")
    }
  }
}

/// A requested path split into the granted folder that contains it and the components below it.
public struct ResolvedPath: Equatable {
  public var folder: String
  public var relative: [String]
  public var absolute: String { ([folder] + relative).joined(separator: "/") }
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
      throw ActionError(.protectedPath, "\(pattern.joined(separator: "/")) is protected and never shared with assistants.")
    }
    let containing = folders.filter {
      components.count >= $0.components.count && Array(components.prefix($0.components.count)) == $0.components
    }
    guard let folder = containing.max(by: { $0.components.count < $1.components.count }) else {
      throw ActionError(.outsideFolders, "/\(components.joined(separator: "/")) is outside the folders shared on this Mac.")
    }
    return (folder, ResolvedPath(folder: folder.path, relative: Array(components.dropFirst(folder.components.count))))
  }
}

/// File actions on granted folders. Every call opens from the folder descriptor with
/// `O_NOFOLLOW` per component, refuses symbolic links, special files and files with more than
/// one hard link, and writes through a temporary file renamed into place.
public enum SafeFiles {
  /// Hashing a whole file is the cost of `read_file`; bigger files are refused up front.
  public static let maxHashedFileSize: Int64 = 1 << 30

  // MARK: Actions

  public static func readFile(folder: FolderHandle, path: ResolvedPath, offset: Int, length: Int) throws -> JSONValue {
    try folder.verify()
    guard let name = path.relative.last else { throw ActionError(.notAFile, "\(path.absolute) is a folder.") }
    let parent = try openParent(folder, path)
    defer { close(parent) }
    let fd = try openRegularFile(parent, name, display: path.absolute)
    defer { close(fd) }
    var info = stat()
    fstat(fd, &info)
    let size = Int64(info.st_size)
    guard size <= maxHashedFileSize else { throw ActionError(.tooLarge, "\(path.absolute) is larger than 1 GiB.") }
    guard Int64(offset) <= size else {
      throw ActionError(.invalidArguments, "offset \(offset) is past the end of the file (\(size) bytes).")
    }
    let digest = try sha256(fd: fd, size: size)
    let count = Int(min(Int64(length), size - Int64(offset)))
    var slice = Data(count: count)
    if count > 0 {
      let read = slice.withUnsafeMutableBytes { pread(fd, $0.baseAddress, count, off_t(offset)) }
      guard read == count else { throw ActionError(.failed, "\(path.absolute) changed while it was read.") }
    }
    let text = String(data: slice, encoding: .utf8)
    return [
      "path": .string(path.absolute), "size": .int(Int(size)), "sha256": .string(digest), "offset": .int(offset),
      "encoding": text == nil ? "base64" : "utf8", "content": .string(text ?? slice.base64EncodedString()),
      "eof": .bool(Int64(offset + count) >= size),
    ]
  }

  public static func writeFile(
    folder: FolderHandle, path: ResolvedPath, content: Data, expectedSha256: String?, createOnly: Bool
  ) throws -> JSONValue {
    try folder.verify()
    guard let name = path.relative.last else { throw ActionError(.notAFile, "\(path.absolute) is a folder.") }
    let parent = try openParent(folder, path)
    defer { close(parent) }
    var existing = stat()
    let exists: Bool
    if fstatat(parent, name, &existing, AT_SYMLINK_NOFOLLOW) == 0 {
      exists = true
      if createOnly { throw ActionError(.exists, "\(path.absolute) already exists.") }
      try checkReplaceable(existing, display: path.absolute)
      if let expectedSha256 {
        let fd = try openRegularFile(parent, name, display: path.absolute)
        defer { close(fd) }
        var info = stat()
        fstat(fd, &info)
        guard try sha256(fd: fd, size: Int64(info.st_size)) == expectedSha256 else {
          throw ActionError(.conflict, "\(path.absolute) has changed since that version.")
        }
      }
    } else if errno == ENOENT {
      exists = false
      if expectedSha256 != nil {
        throw ActionError(.conflict, "\(path.absolute) no longer exists, so that version cannot be replaced.")
      }
    } else {
      throw posixError(errno, display: path.absolute)
    }

    let temp = ".wildbots-write-\(UUID().uuidString)"
    let mode = exists ? mode_t(existing.st_mode & 0o777) : 0o644
    let tempFd = openat(parent, temp, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, mode)
    guard tempFd >= 0 else { throw posixError(errno, display: path.absolute) }
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
            throw posixError(errno, display: path.absolute)
          }
          written += result
        }
      }
      fchmod(tempFd, mode)
      guard fsync(tempFd) == 0 else { throw posixError(errno, display: path.absolute) }
    }

    if let expectedSha256 {
      // Swap atomically, then check what was swapped out. Another writer between the hash check
      // above and here is caught, and its file is swapped back.
      guard renameatx_np(parent, temp, parent, name, UInt32(RENAME_SWAP)) == 0 else {
        throw errno == ENOENT
          ? ActionError(.conflict, "\(path.absolute) no longer exists, so that version cannot be replaced.")
          : posixError(errno, display: path.absolute)
      }
      var swapped = stat()
      var still = false
      if fstatat(parent, temp, &swapped, AT_SYMLINK_NOFOLLOW) == 0, (swapped.st_mode & S_IFMT) == S_IFREG,
        swapped.st_nlink == 1
      {
        let fd = openat(parent, temp, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
        if fd >= 0 {
          defer { close(fd) }
          still = (try? sha256(fd: fd, size: Int64(swapped.st_size))) == expectedSha256
        }
      }
      if !still {
        renameatx_np(parent, temp, parent, name, UInt32(RENAME_SWAP))
        throw ActionError(.conflict, "\(path.absolute) changed while it was being replaced.")
      }
    } else if !exists {
      guard renameatx_np(parent, temp, parent, name, UInt32(RENAME_EXCL)) == 0 else {
        throw errno == EEXIST
          ? ActionError(.exists, "\(path.absolute) was created by something else at the same time.")
          : posixError(errno, display: path.absolute)
      }
      renamed = true
    } else {
      guard renameat(parent, temp, parent, name) == 0 else { throw posixError(errno, display: path.absolute) }
      renamed = true
    }
    fsync(parent)
    let digest = SHA256.hash(data: content).map { String(format: "%02x", $0) }.joined()
    return [
      "path": .string(path.absolute), "size": .int(content.count), "sha256": .string(digest), "created": .bool(!exists),
    ]
  }

  public static func listDir(folder: FolderHandle, path: ResolvedPath, offset: Int, limit: Int) throws -> JSONValue {
    try folder.verify()
    let directory: Int32
    if let name = path.relative.last {
      let parent = try openParent(folder, path)
      defer { close(parent) }
      directory = try openDirectory(parent, name, display: path.absolute)
    } else {
      directory = dup(folder.fd)
    }
    defer { close(directory) }
    let names = try entryNames(directory, display: path.absolute)
    guard offset <= names.count else {
      throw ActionError(.invalidArguments, "offset \(offset) is past the end of the listing (\(names.count) entries).")
    }
    let formatter = ISO8601DateFormatter()
    var entries: [JSONValue] = []
    for name in names[offset..<min(names.count, offset + limit)] {
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
    guard current >= 0 else { throw posixError(errno, display: path.absolute) }
    var walked = folder.path
    for component in path.relative.dropLast() {
      walked += "/" + component
      let next: Int32
      do {
        next = try openDirectory(current, component, display: walked)
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

  static func sha256(fd: Int32, size: Int64) throws -> String {
    var hasher = SHA256()
    var buffer = [UInt8](repeating: 0, count: 1 << 20)
    var position: Int64 = 0
    while true {
      let count = buffer.withUnsafeMutableBytes { pread(fd, $0.baseAddress, $0.count, off_t(position)) }
      if count < 0 {
        if errno == EINTR { continue }
        throw posixError(errno, display: "the file")
      }
      if count == 0 { break }
      hasher.update(data: buffer[0..<count])
      position += Int64(count)
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
