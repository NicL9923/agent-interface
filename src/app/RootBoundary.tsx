import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button } from "../components/ui/button";
import { reportClientError } from "./error-reports";

/**
 * The last error boundary: a render failure anywhere else shows this instead of a blank page, and
 * is reported. Chat and group drafts are written to this device on every edit, so a reload keeps them.
 */
export class RootBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: unknown, info: ErrorInfo) {
    reportClientError("render", error, info.componentStack ?? undefined);
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return <main className="welcome" role="alert">
      <p className="eyebrow">WildBots</p>
      <h1>Something went wrong</h1>
      <p>Reload to try again. Your message drafts are kept.</p>
      <Button className="primary" onClick={() => location.reload()}>Reload</Button>
    </main>;
  }
}
