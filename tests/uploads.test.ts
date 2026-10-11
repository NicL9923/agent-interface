import { describe, expect, it } from "vitest";
import { MAX_UPLOAD_BYTES, namePastedFile, pastedFiles, prepareUpload } from "../src/shared/uploads";

const file = (name: string, type: string, size = 4) => new File([new Uint8Array(size)], name, { type });
const clipboard = (files: File[], text = "") => ({ files: files as unknown as FileList, getData: (kind: string) => kind === "text/plain" ? text : "" });

describe("attachment rules", () => {
  it("sends Markdown and CSV as plain text and refuses formats Hermes can't read", () => {
    for (const [name, type] of [["notes.md", "text/markdown"], ["rows.csv", "text/csv"], ["notes.md", ""]]) {
      const prepared = prepareUpload(file(name, type));
      expect("file" in prepared && [prepared.file.name, prepared.file.type]).toEqual([name, "text/plain"]);
    }
    expect(prepareUpload(file("photo.heic", "image/heic"))).toEqual({ error: expect.stringContaining("photo.heic can't be attached") });
    expect(prepareUpload(file("letter.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"))).toHaveProperty("error");
  });

  it("names the size limit before uploading an oversized file", () => {
    expect(prepareUpload(file("scan.pdf", "application/pdf", MAX_UPLOAD_BYTES))).toHaveProperty("file");
    expect(prepareUpload(file("scan.pdf", "application/pdf", MAX_UPLOAD_BYTES + 1))).toEqual({ error: "scan.pdf is 20 MB. Each attachment can be up to 20 MB." });
  });

  it("attaches screenshots and copied files but keeps copied spreadsheet cells a text paste", () => {
    const shot = file("image.png", "image/png");
    expect(pastedFiles(clipboard([shot]))).toEqual([shot]);
    expect(pastedFiles(clipboard([shot], "Q3\t1,200\nQ4\t1,450"))).toEqual([]);
    const copied = file("receipt.pdf", "application/pdf");
    expect(pastedFiles(clipboard([copied], "receipt.pdf"))).toEqual([copied]);
    expect(pastedFiles(clipboard([], "plain words"))).toEqual([]);
  });

  it("gives each pasted screenshot a distinct readable name and keeps real file names", () => {
    const at = new Date(2026, 9, 11, 9, 5, 7);
    expect(namePastedFile(file("image.png", "image/png"), at, 0).name).toBe("Pasted image 09.05.07.png");
    expect(namePastedFile(file("image.png", "image/jpeg"), at, 1).name).toBe("Pasted image 09.05.07 (2).jpg");
    expect(namePastedFile(file("trail-map.png", "image/png"), at, 0).name).toBe("trail-map.png");
  });
});
