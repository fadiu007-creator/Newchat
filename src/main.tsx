import React, { Component, type ErrorInfo, type ReactNode } from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";

class AppErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, _info: ErrorInfo) {
    console.error("Newchat failed to render:", error);
  }

  render() {
    if (this.state.error) {
      return (
        <main style={{ minHeight: "100vh", background: "#101114", color: "#f1f0f5", display: "grid", placeItems: "center", padding: 24, fontFamily: "system-ui, sans-serif" }}>
          <section style={{ maxWidth: 560, width: "100%", padding: 24, border: "1px solid #45404f", borderRadius: 16, background: "#1a1b20" }}>
            <h1 style={{ marginTop: 0 }}>Newchat could not start</h1>
            <p style={{ color: "#c3c0ca", lineHeight: 1.6 }}>The app encountered a startup error. Reload the page. If this continues, send the error below to support.</p>
            <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", color: "#ffbaba", fontSize: 12 }}>{this.state.error.message}</pre>
            <button onClick={() => window.location.reload()} style={{ padding: "10px 15px", border: 0, borderRadius: 8, background: "#e8e5f2", color: "#24212e", fontWeight: 700 }}>Reload Newchat</button>
          </section>
        </main>
      );
    }
    return this.props.children;
  }
}

const root = document.getElementById("root");
if (!root) throw new Error("Newchat root element was not found.");
ReactDOM.createRoot(root).render(
  <React.StrictMode><AppErrorBoundary><App /></AppErrorBoundary></React.StrictMode>
);
(window as Window & { __newchatMarkStarted?: () => void }).__newchatMarkStarted?.();
