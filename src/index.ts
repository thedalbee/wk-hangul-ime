/**
 * WKWebView Hangul IME Emulator for xterm.js
 *
 * Safari/WKWebView does NOT fire compositionstart/compositionend for Korean IME
 * (WebKit Bug #274700). Instead it fires:
 *   - inputType "insertText" for initial jamo (ㅎ)
 *   - inputType "insertReplacementText" for composition updates (ㅎ→하→한)
 *
 * This module intercepts these input events on xterm.js's textarea,
 * blocks them from reaching xterm's _inputEvent handler, and
 * flushes the final composed text when composition ends.
 *
 * Based on xterm.js PR #5704 (minemos) — adapted as external interceptor
 * per maintainer (Tyriar) recommendation.
 *
 * @see https://github.com/xtermjs/xterm.js/pull/5704
 * @see https://bugs.webkit.org/show_bug.cgi?id=274700
 *
 * @example
 * ```typescript
 * import { Terminal } from "@xterm/xterm";
 * import { attachWkHangulIme } from "wk-hangul-ime";
 *
 * const terminal = new Terminal();
 * terminal.open(container);
 *
 * const ime = attachWkHangulIme(terminal, (composedText) => {
 *   // Send composed Korean text to your backend (PTY, WebSocket, etc.)
 *   ptyWrite(composedText);
 * });
 *
 * terminal.onData((data) => {
 *   if (ime.shouldSkip(data)) return; // Skip leaked jamo during composition
 *   ptyWrite(data);
 * });
 *
 * // Cleanup
 * ime.dispose();
 * ```
 */

export function isHangul(text: string): boolean {
  if (!text) return false;
  const cp = text.codePointAt(0)!;
  return (
    (cp >= 0x1100 && cp <= 0x11ff) || // Hangul Jamo
    (cp >= 0x3130 && cp <= 0x318f) || // Hangul Compatibility Jamo
    (cp >= 0xac00 && cp <= 0xd7af) || // Hangul Syllables
    (cp >= 0xa960 && cp <= 0xa97f) || // Hangul Jamo Extended-A
    (cp >= 0xd7b0 && cp <= 0xd7ff)   // Hangul Jamo Extended-B
  );
}

export interface WkHangulImeHandle {
  /**
   * Call from terminal.onData — returns true if the data is Korean jamo
   * that leaked through during active composition and should be skipped.
   */
  shouldSkip(data: string): boolean;
  /** Remove all event listeners */
  dispose(): void;
}

/**
 * Attach WKWebView Hangul IME handling to an xterm.js Terminal instance.
 *
 * Must be called AFTER `terminal.open(container)` so `terminal.textarea` exists.
 *
 * Works with xterm.js v5.x and v6.x (any version with `terminal.textarea` API).
 *
 * Three-layer defense:
 * 1. `attachCustomKeyEventHandler` — blocks keyCode 229 from reaching xterm's
 *    _keyDown and CompositionHelper._handleAnyTextareaChanges
 * 2. `stopImmediatePropagation` on input events — blocks xterm's _inputEvent
 *    from processing insertReplacementText and Hangul insertText
 * 3. `shouldSkip()` — filters any remaining jamo that leak through onData
 *
 * @param terminal - xterm.js Terminal instance (after open())
 * @param onComposed - callback receiving the final composed Korean text
 * @returns Handle with shouldSkip() and dispose() methods
 */
export function attachWkHangulIme(
  terminal: { textarea?: HTMLTextAreaElement; attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean): void },
  onComposed: (text: string) => void
): WkHangulImeHandle {
  const ta = terminal.textarea;
  if (!ta) return { shouldSkip: () => false, dispose: () => {} };

  let composing = false;
  let pending = "";

  function flush(): void {
    if (!composing) return;
    const text = pending;
    composing = false;
    pending = "";
    if (text) {
      onComposed(text);
    }
  }

  function onKeydown(e: KeyboardEvent): void {
    if (composing && e.keyCode !== 229) {
      flush();
    }
  }

  function onInput(e: Event): void {
    const ie = e as InputEvent;

    // 1. insertReplacementText = WKWebView composition update (ㅎ→하→한)
    if (ie.inputType === "insertReplacementText" && ie.data) {
      composing = true;
      pending = ie.data;
      e.stopImmediatePropagation();
      e.preventDefault();
      return;
    }

    // 2. Hangul insertText = initial jamo or start of new syllable
    if (ie.inputType === "insertText" && ie.data && isHangul(ie.data)) {
      if (composing) {
        flush(); // flush previous syllable
      }
      composing = true;
      pending = ie.data;
      e.stopImmediatePropagation();
      e.preventDefault();
      return;
    }

    // 3. Non-Hangul input — flush any pending composition
    if (composing) {
      flush();
    }
  }

  function onBlur(): void {
    if (composing) {
      flush();
    }
  }

  // Attach listeners in capture phase (fires before xterm's target-phase handlers)
  ta.addEventListener("keydown", onKeydown, true);
  ta.addEventListener("input", onInput, true);
  ta.addEventListener("blur", onBlur, true);

  // Block xterm's _keyDown + CompositionHelper for IME keys.
  // Without this, CompositionHelper reads textarea value on keydown(229)
  // and sends partial jamo via triggerDataEvent → onData.
  terminal.attachCustomKeyEventHandler((event: KeyboardEvent) => {
    if (event.type === "keydown" && (event.keyCode === 229 || event.isComposing)) {
      return false;
    }
    return true;
  });

  return {
    shouldSkip(data: string): boolean {
      if (composing && data.length === 1 && isHangul(data)) return true;
      return false;
    },
    dispose() {
      ta.removeEventListener("keydown", onKeydown, true);
      ta.removeEventListener("input", onInput, true);
      ta.removeEventListener("blur", onBlur, true);
    },
  };
}
