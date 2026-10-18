/** A stand-in for the browser's EventSource that tests open, notify and drop by hand. */
export class FakeEventSource extends EventTarget {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;
  /** Streams the page has open, in creation order. */
  static streams = new Set<FakeEventSource>();
  static created: string[] = [];
  readyState = FakeEventSource.CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  constructor(readonly url: string) {
    super();
    FakeEventSource.streams.add(this);
    FakeEventSource.created.push(url);
  }
  static reset() {
    FakeEventSource.streams.clear();
    FakeEventSource.created = [];
  }
  /** Sends a change notice on every open stream. */
  static notifyAll() {
    for (const stream of FakeEventSource.streams) if (stream.url !== "/api/events") stream.emit("message", "change");
  }
  connect() {
    this.readyState = FakeEventSource.OPEN;
    const event = new Event("open");
    this.onopen?.(event);
    this.dispatchEvent(event);
  }
  emit(type: string, data: string) {
    const event = new MessageEvent(type, { data });
    if (type === "message") this.onmessage?.(event);
    this.dispatchEvent(event);
  }
  /** A refusal, which EventSource never retries. */
  fail() {
    this.readyState = FakeEventSource.CLOSED;
    FakeEventSource.streams.delete(this);
    this.onerror?.(new Event("error"));
  }
  close() {
    this.readyState = FakeEventSource.CLOSED;
    FakeEventSource.streams.delete(this);
  }
}
