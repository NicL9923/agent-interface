import AppKit

// Original geometric companion artwork, drawn locally without external assets.
let output = URL(fileURLWithPath: CommandLine.arguments[1])
let size = 1024
let context = CGContext(data:nil,width:size,height:size,bitsPerComponent:8,bytesPerRow:0,space:CGColorSpaceCreateDeviceRGB(),bitmapInfo:CGImageAlphaInfo.noneSkipLast.rawValue)!
context.setFillColor(CGColor(red:0.98,green:0.973,blue:0.949,alpha:1));context.fill(CGRect(x:0,y:0,width:size,height:size))
context.setFillColor(CGColor(red:0.14,green:0.44,blue:0.35,alpha:1))
let body=CGMutablePath();body.move(to:CGPoint(x:512,y:180));body.addCurve(to:CGPoint(x:180,y:512),control1:CGPoint(x:310,y:155),control2:CGPoint(x:170,y:305));body.addCurve(to:CGPoint(x:512,y:845),control1:CGPoint(x:157,y:723),control2:CGPoint(x:306,y:862));body.addCurve(to:CGPoint(x:845,y:512),control1:CGPoint(x:726,y:864),control2:CGPoint(x:859,y:726));body.addCurve(to:CGPoint(x:512,y:180),control1:CGPoint(x:858,y:302),control2:CGPoint(x:721,y:155));body.closeSubpath();context.addPath(body);context.fillPath()
context.setFillColor(CGColor(red:1,green:0.976,blue:0.933,alpha:1))
for x in [375,585] {context.addPath(CGPath(roundedRect:CGRect(x:x,y:450,width:64,height:155),cornerWidth:32,cornerHeight:32,transform:nil));context.fillPath()}
let image=context.makeImage()!;let bitmap=NSBitmapImageRep(cgImage:image)
try FileManager.default.createDirectory(at:output.deletingLastPathComponent(),withIntermediateDirectories:true)
try bitmap.representation(using:.png,properties:[:])!.write(to:output)
