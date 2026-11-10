/** A stand-in for the browser's EventSource that tests open, notify and drop by hand. */
export class FakeEventSource extends EventTarget {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;
  /** Streams the page has open, in creation order. */
  static streams = new Set<FakeEventSource>();
  static created: string[] = [];
  readyState = FakeEventSource.CONNECTING;
  /** When the page opened this stream, on the test's clock. */
  readonly at = Date.now();
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  /** Every stream the page opened, in creation order, closed ones included. */
  static opened: FakeEventSource[] = [];
  /** When set, answers each new stream as a server would, after the network's millisecond. */
  static serve: ((source: FakeEventSource) => void) | undefined;
  constructor(readonly url: string) {
    super();
    FakeEventSource.streams.add(this);
    FakeEventSource.created.push(url);
    FakeEventSource.opened.push(this);
    const serve = FakeEventSource.serve;
    if (serve) setTimeout(() => serve(this), 0);
  }
  static reset() {
    FakeEventSource.streams.clear();
    FakeEventSource.created = [];
    FakeEventSource.opened = [];
    FakeEventSource.serve = undefined;
  }
  /** Sends a change notice on every open stream but the household one, whatever its query names. */
  static notifyAll() {
    for (const stream of FakeEventSource.streams) {
      const url = new URL(stream.url, "http://localhost");
      if (url.pathname !== "/api/events" || url.searchParams.has("group")) stream.emit("message", "change");
    }
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
  /** A dropped connection, which EventSource retries itself. */
  drop() {
    this.readyState = FakeEventSource.CONNECTING;
    this.onerror?.(new Event("error"));
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
