import { fileKind, fileTypeNames, REPLY_CHIP_LIMIT, type Artifact, type FileKind } from "../shared/artifacts";
import { Icon, type IconName } from "../components/Icon";

const icons: Record<FileKind, IconName> = { image: "image", text: "file-text", document: "file", audio: "audio", video: "video", other: "file" };

/**
 * The files a reply's turn produced, as chips under it. Each opens the Artifacts panel on that file;
 * past four, the last chip opens the whole list.
 */
export function ReplyFiles({ artifacts, onOpen }: { artifacts: Artifact[]; onOpen(fileId?: string): void }) {
  const shown = artifacts.slice(0, REPLY_CHIP_LIMIT), more = artifacts.length - shown.length;
  return <div className="reply-files" role="group" aria-label="Files from this reply">
    {shown.map(({ file }) => {
      const kind = fileKind(file);
      return <button key={file.id} type="button" className="reply-file" title={file.name}
        aria-label={`${file.name}, ${fileTypeNames[kind]}. Open in Artifacts`} onClick={() => onOpen(file.id)}>
        <Icon name={icons[kind]} size={16} /><span className="reply-file-name">{file.name}</span>
      </button>;
    })}
    {more > 0 && <button type="button" className="reply-file reply-file-more" aria-label={`${more} more ${more === 1 ? "file" : "files"}. Open Artifacts`}
      onClick={() => onOpen()}>+{more} more</button>}
  </div>;
}
