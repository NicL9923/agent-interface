declare module "@novnc/novnc" {
  export default class RFB extends EventTarget {
    constructor(target: HTMLElement, url: string, options?: Record<string, unknown>);
    viewOnly: boolean;
    scaleViewport: boolean;
    resizeSession: boolean;
    showDotCursor: boolean;
    disconnect(): void;
    focus(): void;
    sendCtrlAltDel(): void;
    sendKey(keysym: number, code?: string, down?: boolean): void;
    clipboardPasteFrom(text: string): void;
  }
}
