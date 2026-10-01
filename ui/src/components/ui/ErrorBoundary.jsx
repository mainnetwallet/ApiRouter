import { Component } from "react";
import { Icon } from "./Icon.jsx";
import { sanitizeText } from "../../lib/sanitize.js";

/**
 * Last-resort render guard.
 *
 * A single malformed API payload should not blank the entire panel. The
 * boundary shows the sanitized error and offers a recovery action; the message
 * goes through `sanitizeText` because a stack trace can embed request data.
 */
export class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // Kept as a structured, sanitized record. Never the raw error object,
    // which can carry request or credential material in its properties.
    console.error("Panel render error:", sanitizeText(error?.message), sanitizeText(info?.componentStack, { maxLength: 400 }));
  }

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <div className="state state--error" role="alert">
        <Icon name="alert" className="state__icon" size={26} />
        <div className="state__title">This page failed to render</div>
        <div className="state__body">
          The gateway itself is unaffected — this is a fault in the control panel.
        </div>
        <div className="state__body mono tiny">{sanitizeText(this.state.error?.message) || "Unknown error"}</div>
        <button type="button" className="btn" onClick={() => this.setState({ error: null })}>
          <Icon name="refresh" className="btn__icon" size={13} />
          Try again
        </button>
      </div>
    );
  }
}
