import CryptoKit
import XCTest

@testable import WildBotsMacCore

final class SafeFilesTests: XCTestCase {
  var box: Sandbox!
  var folder: FolderHandle!

  override func setUpWithError() throws {
    box = try Sandbox()
    folder = try box.folder()
  }

  func resolve(_ path: String) throws -> (FolderHandle, ResolvedPath) {
    try PathResolver.resolve(path, folders: [folder], home: box.home)
  }
  func read(_ path: String, offset: Int = 0, length: Int = 262_144) throws -> JSONValue {
    let (folder, resolved) = try resolve(path)
    return try SafeFiles.readFile(folder: folder, path: resolved, offset: offset, length: length)
  }
  func write(_ path: String, _ text: String, expected: String? = nil, createOnly: Bool = false) throws -> JSONValue {
    let (folder, resolved) = try resolve(path)
    return try SafeFiles.writeFile(
      folder: folder, path: resolved, content: Data(text.utf8), expectedSha256: expected, createOnly: createOnly)
  }
  func list(_ path: String, offset: Int = 0, limit: Int = 200) throws -> JSONValue {
    let (folder, resolved) = try resolve(path)
    return try SafeFiles.listDir(folder: folder, path: resolved, offset: offset, limit: limit)
  }
  func sha(_ text: String) -> String { SHA256.hash(data: Data(text.utf8)).map { String(format: "%02x", $0) }.joined() }

  // MARK: Resolution

  func testResolvesRelativeHomeAndDotDotPathsAgainstTheFolders() throws {
    XCTAssertEqual(try resolve("notes/a.txt").1.absolute, box.granted + "/notes/a.txt")
    XCTAssertEqual(try resolve(box.granted + "/./x/../y").1.relative, ["y"])
    XCTAssertEqual(try resolve("~/dev/z").1.absolute, box.granted + "/z")
    assertActionError(.outsideFolders, containing: "outside the folders") { try resolve("../secret.txt") }
    assertActionError(.outsideFolders, containing: "outside the folders") { try resolve(box.outside + "/a") }
    assertActionError(.outsideFolders, containing: "home folder") { try resolve("~root/x") }
    assertActionError(.protectedPath, containing: ".ssh") { try resolve("project/.SSH/id_ed25519") }
    assertActionError(.outsideFolders, containing: "No folders") {
      try PathResolver.resolve("a", folders: [], home: box.home)
    }
  }

  /// With overlapping folders an assistant that can write the outer one can swap a folder above
  /// the inner one for a link. Neither the handle granted earlier nor a rebuilt one may follow it.
  func testAFolderAboveAGrantedFolderSwappedForALinkIsRefused() throws {
    let innerPath = box.granted + "/project/Documents"
    try FileManager.default.createDirectory(atPath: innerPath, withIntermediateDirectories: true)
    box.write(box.outside + "/Documents/secret.txt", "secret")
    let inner = try FolderHandle(name: "Documents", path: innerPath)
    try FileManager.default.moveItem(atPath: box.granted + "/project", toPath: box.granted + "/project-real")

    // A link back to the same directory still makes the granted path go through a link.
    try FileManager.default.createSymbolicLink(atPath: box.granted + "/project", withDestinationPath: box.granted + "/project-real")
    let (chosen, resolved) = try PathResolver.resolve(innerPath + "/a.txt", folders: [folder, inner], home: box.home)
    XCTAssertEqual(chosen.path, innerPath)
    assertActionError(.notFound, containing: "moved or replaced") {
      try SafeFiles.writeFile(folder: chosen, path: resolved, content: Data("x".utf8), expectedSha256: nil, createOnly: false)
    }
    XCTAssertNil(box.read(box.granted + "/project-real/Documents/a.txt"))

    // Rebuilding the folder list after the link points elsewhere refuses to open the folder.
    try FileManager.default.removeItem(atPath: box.granted + "/project")
    try FileManager.default.createSymbolicLink(atPath: box.granted + "/project", withDestinationPath: box.outside)
    assertActionError(.notFound, containing: "/project is a symbolic link") {
      try FolderHandle(name: "Documents", path: innerPath)
    }
  }

  func testPrefersTheMostSpecificFolder() throws {
    try FileManager.default.createDirectory(atPath: box.granted + "/inner", withIntermediateDirectories: true)
    let inner = try FolderHandle(name: "inner", path: box.granted + "/inner")
    let (chosen, resolved) = try PathResolver.resolve(box.granted + "/inner/a", folders: [folder, inner], home: box.home)
    XCTAssertEqual(chosen.path, inner.path)
    XCTAssertEqual(resolved.relative, ["a"])
  }

  // MARK: read_file

  func testReadsPagesWithAWholeFileHashAndEof() throws {
    box.write(box.granted + "/a.txt", "hello world")
    let first = try read("a.txt", offset: 0, length: 5)
    XCTAssertEqual(first["content"], "hello")
    XCTAssertEqual(first["encoding"], "utf8")
    XCTAssertEqual(first["sha256"], .string(sha("hello world")))
    XCTAssertEqual(first["size"], 11)
    XCTAssertEqual(first["eof"], false)
    let last = try read("a.txt", offset: 6, length: 100)
    XCTAssertEqual(last["content"], "world")
    XCTAssertEqual(last["eof"], true)
    XCTAssertEqual(try read("a.txt", offset: 11)["content"], "")
    assertActionError(.invalidArguments, containing: "past the end") { try read("a.txt", offset: 12) }
  }

  func testBinaryContentComesBackAsBase64() throws {
    let bytes = Data([0xff, 0xfe, 0x00, 0x01])
    FileManager.default.createFile(atPath: box.granted + "/b.bin", contents: bytes)
    let result = try read("b.bin")
    XCTAssertEqual(result["encoding"], "base64")
    XCTAssertEqual(result["content"], .string(bytes.base64EncodedString()))
  }

  func testRefusesLinksSpecialFilesAndFolders() throws {
    box.write(box.outside + "/secret.txt", "secret")
    try FileManager.default.createSymbolicLink(atPath: box.granted + "/link.txt", withDestinationPath: box.outside + "/secret.txt")
    try FileManager.default.createSymbolicLink(atPath: box.granted + "/linkdir", withDestinationPath: box.outside)
    try FileManager.default.linkItem(atPath: box.outside + "/secret.txt", toPath: box.granted + "/hard.txt")
    XCTAssertEqual(mkfifo(box.granted + "/fifo", 0o600), 0)
    try FileManager.default.createDirectory(atPath: box.granted + "/dir", withIntermediateDirectories: true)

    assertActionError(.outsideFolders, containing: "symbolic link") { try read("link.txt") }
    assertActionError(.outsideFolders, containing: "symbolic link") { try read("linkdir/secret.txt") }
    assertActionError(.hardLink, containing: "more than one hard link") { try read("hard.txt") }
    // Opening a FIFO for reading would block forever; it must be refused without opening.
    assertActionError(.notAFile, containing: "not a regular file") { try read("fifo") }
    assertActionError(.notAFile, containing: "is a folder") { try read("dir") }
    assertActionError(.notAFile, containing: "is a folder") { try read(".") }
    assertActionError(.notFound, containing: "does not exist") { try read("missing.txt") }
    box.write(box.granted + "/plain", "x")
    assertActionError(.notADirectory, containing: "not a folder") { try read("plain/child") }
  }

  /// The retained descriptor must not follow a granted folder that moved: the command sandbox
  /// confines by path, so file actions refuse rather than act on the moved directory.
  func testRefusesWhenTheFolderWasMovedOrReplaced() throws {
    box.write(box.granted + "/a.txt", "x")
    try FileManager.default.moveItem(atPath: box.granted, toPath: box.home + "/moved")
    try FileManager.default.createSymbolicLink(atPath: box.granted, withDestinationPath: box.outside)
    assertActionError(.notFound, containing: "moved or replaced") { try read("a.txt") }
    assertActionError(.notFound, containing: "moved or replaced") { try write("b.txt", "y") }
    XCTAssertNil(box.read(box.outside + "/b.txt"))
  }

  // MARK: write_file

  func testCreatesReplacesAndReportsCreated() throws {
    let created = try write("new.txt", "one")
    XCTAssertEqual(created["created"], true)
    XCTAssertEqual(created["sha256"], .string(sha("one")))
    XCTAssertEqual(box.read(box.granted + "/new.txt"), "one")
    let replaced = try write("new.txt", "two")
    XCTAssertEqual(replaced["created"], false)
    XCTAssertEqual(box.read(box.granted + "/new.txt"), "two")
    let leftovers = try FileManager.default.contentsOfDirectory(atPath: box.granted).filter { $0.hasPrefix(".wildbots-write-") }
    XCTAssertEqual(leftovers, [])
  }

  func testCreateOnlyAndExpectedVersionGuards() throws {
    box.write(box.granted + "/a.txt", "v1")
    let inode = try FileManager.default.attributesOfItem(atPath: box.granted + "/a.txt")[.systemFileNumber] as? Int
    assertActionError(.exists, containing: "already exists") { try write("a.txt", "x", createOnly: true) }
    assertActionError(.conflict, containing: "changed since") { try write("a.txt", "x", expected: sha("other")) }
    XCTAssertEqual(box.read(box.granted + "/a.txt"), "v1")
    // A refused version is never swapped in, even for a moment: the file is the same one.
    XCTAssertEqual(try FileManager.default.attributesOfItem(atPath: box.granted + "/a.txt")[.systemFileNumber] as? Int, inode)
    XCTAssertEqual(try write("a.txt", "v2", expected: sha("v1"))["created"], false)
    XCTAssertEqual(box.read(box.granted + "/a.txt"), "v2")
    assertActionError(.conflict, containing: "no longer exists") { try write("gone.txt", "x", expected: sha("v1")) }
    XCTAssertNil(box.read(box.granted + "/gone.txt"))
    let leftovers = try FileManager.default.contentsOfDirectory(atPath: box.granted).filter { $0.hasPrefix(".wildbots-write-") }
    XCTAssertEqual(leftovers, [])
  }

  func testKeepsTheReplacedFilesPermissions() throws {
    box.write(box.granted + "/run.sh", "#!/bin/sh")
    chmod(box.granted + "/run.sh", 0o750)
    _ = try write("run.sh", "#!/bin/sh\necho hi")
    let mode = try FileManager.default.attributesOfItem(atPath: box.granted + "/run.sh")[.posixPermissions] as? Int
    XCTAssertEqual(mode, 0o750)
  }

  func testWriteRefusesLinksHardLinksAndMissingParents() throws {
    box.write(box.outside + "/target.txt", "keep")
    try FileManager.default.createSymbolicLink(atPath: box.granted + "/out", withDestinationPath: box.outside)
    try FileManager.default.createSymbolicLink(atPath: box.granted + "/t.txt", withDestinationPath: box.outside + "/target.txt")
    try FileManager.default.linkItem(atPath: box.outside + "/target.txt", toPath: box.granted + "/h.txt")
    assertActionError(.outsideFolders, containing: "symbolic link") { try write("out/new.txt", "x") }
    assertActionError(.outsideFolders, containing: "symbolic link") { try write("t.txt", "x") }
    assertActionError(.hardLink, containing: "hard link") { try write("h.txt", "x") }
    assertActionError(.notFound, containing: "does not exist") { try write("no/such/dir.txt", "x") }
    assertActionError(.notAFile, containing: "is a folder") { try write(".", "x") }
    XCTAssertEqual(box.read(box.outside + "/target.txt"), "keep")
    XCTAssertNil(box.read(box.outside + "/new.txt"))
  }

  /// Writes that expect the same version take turns, so exactly one replaces it and the rest
  /// see the winner's content and get `conflict`. The file is large so every writer is still
  /// hashing when the others start.
  func testConcurrentWritesExpectingTheSameVersionLetExactlyOneWin() throws {
    let original = Data(repeating: 0x61, count: 16 << 20)
    FileManager.default.createFile(atPath: box.granted + "/v.txt", contents: original)
    let expected = SHA256.hash(data: original).map { String(format: "%02x", $0) }.joined()
    let (folder, resolved) = try resolve("v.txt")
    let lock = NSLock()
    var winners: [Int] = []
    var losers: [ErrorCode] = []
    DispatchQueue.concurrentPerform(iterations: 6) { index in
      do {
        _ = try SafeFiles.writeFile(
          folder: folder, path: resolved, content: Data("writer \(index)".utf8), expectedSha256: expected, createOnly: false)
        lock.withLock { winners.append(index) }
      } catch {
        lock.withLock { losers.append((error as? ActionError)?.code ?? .failed) }
      }
    }
    XCTAssertEqual(winners.count, 1, "winners: \(winners)")
    XCTAssertEqual(losers, Array(repeating: .conflict, count: 5))
    XCTAssertEqual(box.read(box.granted + "/v.txt"), "writer \(winners.first ?? -1)")
    let leftovers = try FileManager.default.contentsOfDirectory(atPath: box.granted).filter { $0.hasPrefix(".wildbots-write-") }
    XCTAssertEqual(leftovers, [])
  }

  /// APFS folds names its own way, and Σ and ς name one file on a case-insensitive volume. A key
  /// built from the name kept them apart, so two versioned writes could both win; writes now take
  /// turns per folder.
  func testWritesUnderTwoSpellingsOfOneNameStillLetExactlyOneWin() throws {
    let original = Data(repeating: 0x61, count: 16 << 20)
    FileManager.default.createFile(atPath: box.granted + "/Σ.txt", contents: original)
    guard FileManager.default.fileExists(atPath: box.granted + "/ς.txt") else {
      throw XCTSkip("This volume treats Σ and ς as different names.")
    }
    let expected = SHA256.hash(data: original).map { String(format: "%02x", $0) }.joined()
    let spellings = try ["Σ.txt", "ς.txt", "σ.txt"].map { try resolve($0) }
    let lock = NSLock()
    var winners: [Int] = []
    var losers: [ErrorCode] = []
    DispatchQueue.concurrentPerform(iterations: 6) { index in
      let (folder, resolved) = spellings[index % spellings.count]
      do {
        _ = try SafeFiles.writeFile(
          folder: folder, path: resolved, content: Data("writer \(index)".utf8), expectedSha256: expected, createOnly: false)
        lock.withLock { winners.append(index) }
      } catch {
        lock.withLock { losers.append((error as? ActionError)?.code ?? .failed) }
      }
    }
    XCTAssertEqual(winners.count, 1, "winners: \(winners)")
    XCTAssertEqual(losers, Array(repeating: .conflict, count: 5))
  }

  func testAListingStopsWhenCancelled() throws {
    for index in 0..<3 { box.write(box.granted + "/f\(index).txt", "x") }
    let (folder, resolved) = try resolve(box.granted)
    let flag = CancellationFlag()
    flag.cancel()
    assertActionError(.paused, containing: "stopped") {
      try SafeFiles.listDir(folder: folder, path: resolved, offset: 0, limit: 10, cancel: flag)
    }
    XCTAssertEqual(try SafeFiles.listDir(folder: folder, path: resolved, offset: 0, limit: 10)["total"], 3)
  }

  func testHashingRefusesFilesOverOneGiBAtEveryEntryPoint() throws {
    let huge = box.granted + "/huge.bin"
    FileManager.default.createFile(atPath: huge, contents: nil)
    XCTAssertEqual(truncate(huge, off_t(SafeFiles.maxHashedFileSize + 1)), 0)
    assertActionError(.tooLarge, containing: "larger than 1 GiB") { try read("huge.bin") }
    assertActionError(.tooLarge, containing: "larger than 1 GiB") { try write("huge.bin", "x", expected: sha("x")) }
    let size = try FileManager.default.attributesOfItem(atPath: huge)[.size] as? Int64
    XCTAssertEqual(size, SafeFiles.maxHashedFileSize + 1)
  }

  /// The size passed in is the one the caller validated; a file that grew or shrank since then
  /// is a conflict, not a hash of something else.
  func testHashingReadsTheValidatedSizeAndRefusesAFileThatChangedSize() throws {
    box.write(box.granted + "/ten.txt", "0123456789")
    let fd = open(box.granted + "/ten.txt", O_RDONLY)
    defer { close(fd) }
    XCTAssertEqual(try SafeFiles.sha256(fd: fd, size: 10, display: "ten.txt"), sha("0123456789"))
    assertActionError(.conflict, containing: "changed size") { try SafeFiles.sha256(fd: fd, size: 4, display: "ten.txt") }
    assertActionError(.conflict, containing: "got shorter") { try SafeFiles.sha256(fd: fd, size: 20, display: "ten.txt") }
  }

  func testCancellationStopsHashingAndKeepsAWriteFromLanding() throws {
    let cancelled = CancellationFlag()
    cancelled.cancel()
    box.write(box.granted + "/ten.txt", "0123456789")
    let fd = open(box.granted + "/ten.txt", O_RDONLY)
    defer { close(fd) }
    assertActionError(.paused, containing: "stopped") {
      try SafeFiles.sha256(fd: fd, size: 10, display: "ten.txt", cancel: cancelled)
    }
    let (folder, resolved) = try resolve("new.txt")
    assertActionError(.paused, containing: "stopped") {
      try SafeFiles.writeFile(
        folder: folder, path: resolved, content: Data("x".utf8), expectedSha256: nil, createOnly: false, cancel: cancelled)
    }
    XCTAssertNil(box.read(box.granted + "/new.txt"))
    let leftovers = try FileManager.default.contentsOfDirectory(atPath: box.granted).filter { $0.hasPrefix(".wildbots-write-") }
    XCTAssertEqual(leftovers, [])
  }

  // MARK: list_dir

  func testListsWithTypesTotalsAndPaging() throws {
    for name in ["c.txt", "a.txt", "b.txt"] { box.write(box.granted + "/" + name, name) }
    try FileManager.default.createDirectory(atPath: box.granted + "/sub", withIntermediateDirectories: true)
    try FileManager.default.createSymbolicLink(atPath: box.granted + "/zlink", withDestinationPath: box.outside)
    let page = try list(".", offset: 0, limit: 2)
    XCTAssertEqual(page["entries"]?.arrayValue?.compactMap { $0["name"]?.stringValue }, ["a.txt", "b.txt"])
    XCTAssertEqual(page["total"], 5)
    XCTAssertEqual(page["nextOffset"], 2)
    let rest = try list(box.granted, offset: 2, limit: 10)
    XCTAssertEqual(rest["entries"]?.arrayValue?.compactMap { $0["type"]?.stringValue }, ["file", "dir", "link"])
    XCTAssertNil(rest["nextOffset"])
    XCTAssertEqual(rest["entries"]?.arrayValue?.first?["size"], 5)
    XCTAssertEqual(try list(".", offset: 5)["entries"], [])
    assertActionError(.invalidArguments, containing: "past the end") { try list(".", offset: 6) }
    assertActionError(.outsideFolders, containing: "symbolic link") { try list("zlink") }
    assertActionError(.notADirectory, containing: "not a folder") { try list("a.txt") }
  }
}
