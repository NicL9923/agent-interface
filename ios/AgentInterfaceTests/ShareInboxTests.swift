import XCTest
import UIKit
import ImageIO
import UniformTypeIdentifiers
@testable import AgentInterface
final class ShareInboxTests:XCTestCase {
  func testPortraitResizesAndPreservesTransparency() throws {
    let format = UIGraphicsImageRendererFormat()
    format.scale = 1
    let image = UIGraphicsImageRenderer(size: CGSize(width: 1600, height: 800), format: format).image { context in
      UIColor.green.setFill()
      context.fill(CGRect(x: 0, y: 0, width: 800, height: 800))
    }
    let data = try PortraitUpload.prepare(image.pngData()!)
    let resized = try XCTUnwrap(UIImage(data: data)?.cgImage)
    XCTAssertEqual(resized.width, 512)
    XCTAssertEqual(resized.height, 256)
    XCTAssertTrue([CGImageAlphaInfo.premultipliedFirst, .premultipliedLast, .first, .last].contains(resized.alphaInfo))
    XCTAssertLessThanOrEqual(data.count, 2_000_000)
    XCTAssertThrowsError(try PortraitUpload.prepare(Data("bad".utf8)))
    XCTAssertThrowsError(try PortraitUpload.prepare(Data(count: PortraitUpload.maxInputBytes + 1)))
    // The source limit is inclusive. PNG decoders tolerate trailing bytes.
    var exactLimit = image.pngData()!
    exactLimit.append(Data(count: PortraitUpload.maxInputBytes - exactLimit.count))
    XCTAssertNoThrow(try PortraitUpload.prepare(exactLimit))
  }
  func testRejectsTraversalAndInvalidCaptureIdentity() {
    var value=SharedCapture(id:UUID().uuidString,scope:"account",text:"Shared webpage",files:["shared-1.pdf"],createdAt:Date())
    XCTAssertTrue(ShareInbox.valid(value));value.files=["../outside.pdf"];XCTAssertFalse(ShareInbox.valid(value));value.files=["shared.pdf"];value.id="../outside";XCTAssertFalse(ShareInbox.valid(value))
  }
  func testImageDataKeepsSupportedMIMEAndConvertsHEIC() throws {
    let image=UIGraphicsImageRenderer(size:CGSize(width:30,height:20)).image { context in UIColor.green.setFill();context.fill(CGRect(x:0,y:0,width:30,height:20)) }
    let png=image.pngData()!;XCTAssertEqual(try ShareImage.prepare(png).ext,"png")
    let jpeg=image.jpegData(compressionQuality:0.9)!;XCTAssertEqual(try ShareImage.prepare(jpeg).ext,"jpg")
    let data=NSMutableData();let destination=CGImageDestinationCreateWithData(data,UTType.heic.identifier as CFString,1,nil)!
    CGImageDestinationAddImage(destination,image.cgImage!,nil)
    XCTAssertTrue(CGImageDestinationFinalize(destination));let converted=try ShareImage.prepare(data as Data);XCTAssertEqual(converted.ext,"png");XCTAssertNotNil(UIImage(data:converted.data))
    XCTAssertThrowsError(try ShareImage.prepare(Data("not an image".utf8)))
  }
  func testActualAppGroupQueueHonorsAccountAndExpiration() throws {
    let root=try XCTUnwrap(ShareInbox.root);try FileManager.default.createDirectory(at:root,withIntermediateDirectories:true)
    let scope=UUID().uuidString
    let capture=SharedCapture(id:UUID().uuidString,scope:scope,botId:"ranch",text:"https://example.invalid/shared",files:[],createdAt:Date())
    defer { ShareInbox.remove(capture) }
    try JSONEncoder().encode(capture).write(to:root.appendingPathComponent(capture.id + ".json"),options:.atomic)
    XCTAssertTrue(ShareInbox.pending(scope:scope).contains {$0.id==capture.id})
    XCTAssertFalse(ShareInbox.pending(scope:"another-account").contains {$0.id==capture.id})
    XCTAssertFalse(FileManager.default.fileExists(atPath:root.appendingPathComponent(capture.id + ".json").path))
  }
  func testBoundedCapture() {
    let value=SharedCapture(id:UUID().uuidString,scope:"account",text:"",files:Array(repeating:"a.pdf",count:11),createdAt:Date());XCTAssertFalse(ShareInbox.valid(value))
  }
}
