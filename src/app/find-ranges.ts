export const readable = ".message-markdown, .message-text";
/** The words each shown message reads, without names, times or tool output. */
export function shownMessages(container: HTMLElement) {
  return [...container.querySelectorAll<HTMLElement>("article[data-message-id]")].map(item => ({
    id: item.dataset.messageId!,
    text: [...item.querySelectorAll(readable)].map(node => node.textContent ?? "").join("\n"),
  }));
}
/** Text ranges of each match inside a message, for the CSS highlight registry. */
export function matchRanges(item: HTMLElement, needle: string) {
  const ranges: Range[] = [];
  for (const block of item.querySelectorAll(readable)) {
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = (node.textContent ?? "").toLocaleLowerCase();
      for (let at = text.indexOf(needle); at >= 0 && at + needle.length <= (node.textContent ?? "").length; at = text.indexOf(needle, at + needle.length)) {
        const range = document.createRange();
        range.setStart(node, at);
        range.setEnd(node, at + needle.length);
        ranges.push(range);
      }
    }
  }
  return ranges;
}
