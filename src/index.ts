/**
 * !! CRITICAL — DO NOT MODIFY WITHOUT TESTING KOREAN INPUT !!
 * !! 이 파일 수정 시 반드시 npm run tauri dev에서 "안녕하세요" 입력 테스트 !!
 * !! GitHub: https://github.com/thedalbee/wk-hangul-ime !!
 *
 * WKWebView Hangul IME Emulator
 *
 * Safari/WKWebView does NOT fire compositionstart/compositionend for Korean IME.
 * Instead it fires:
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
 * Reference: https://github.com/xtermjs/xterm.js/pull/5704
 * WebKit Bug: https://bugs.webkit.org/show_bug.cgi?id=274700
 */

import type { Terminal } from "@xterm/xterm";

function isHangul(text: string): boolean {
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

/**
 * Attach WKWebView Hangul IME handling to an xterm.js Terminal.
 * Call AFTER terminal.open() so terminal.textarea exists.
 * Returns a cleanup function.
 */
export interface WkHangulImeHandle {
  /** Call from terminal.onData — returns true if the data was from IME and should be skipped */
  shouldSkip(data: string): boolean;
  /** Cleanup listeners */
  dispose(): void;
}

export function attachWkHangulIme(
  terminal: Terminal,
  onComposed: (text: string) => void
): WkHangulImeHandle {
  const ta = terminal.textarea;
  if (!ta) return { shouldSkip: () => false, dispose: () => {} };

  let composing = false;
  let pending = "";
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  function clearFlushTimer(): void {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  }

  function flush(): void {
    clearFlushTimer();
    if (!composing) return;
    const text = pending;
    composing = false;
    pending = "";
    // Clear textarea so xterm doesn't re-process the same text
    ta.value = "";
    if (text) {
      onComposed(text);
    }
  }

  function scheduleFlush(): void {
    clearFlushTimer();
    flushTimer = setTimeout(flush, 300);
  }

  // keydown: detect end of IME (non-229 key after composing)
  function onKeydown(e: KeyboardEvent): void {
    if (e.keyCode === 229 || e.isComposing) {
      // Block CompositionHelper's own keydown listener from running
      // _handleAnyTextareaChanges (which sends partial jamo)
      e.stopImmediatePropagation();
      return;
    }
    if (composing) {
      flush();
    }
  }

  // input: intercept insertReplacementText and Hangul insertText
  // Use capture phase to fire BEFORE xterm's handler
  function onInput(e: Event): void {
    const ie = e as InputEvent;

    // 1. insertReplacementText = WKWebView composition update
    if (ie.inputType === "insertReplacementText" && ie.data) {
      composing = true;
      pending = ie.data;
      scheduleFlush(); // auto-flush after 300ms idle
      e.stopImmediatePropagation();
      e.preventDefault();
      return;
    }

    // 2. Hangul insertText = WKWebView initial jamo or new syllable
    if (ie.inputType === "insertText" && ie.data && isHangul(ie.data)) {
      // If we were already composing, flush previous syllable first
      if (composing) {
        flush();
      }
      composing = true;
      pending = ie.data;
      scheduleFlush(); // auto-flush after 300ms idle
      e.stopImmediatePropagation();
      e.preventDefault();
      return;
    }

    // 3. Non-Hangul insertText — flush any pending composition first
    if (composing) {
      flush();
    }
    // Let xterm handle normally
  }

  // blur: flush when focus leaves (user clicks elsewhere)
  function onBlur(): void {
    if (composing) {
      flush();
    }
  }

  // Register on textarea's PARENT element in capture phase.
  // When both our handler and xterm's handler are on the same element (textarea)
  // in capture phase, they fire in registration order — xterm's fires first
  // because it was registered during terminal.open().
  // By attaching to the PARENT, our capture handler fires BEFORE the event
  // reaches the textarea, so stopImmediatePropagation blocks xterm's handler.
  const captureTarget = ta.parentElement ?? ta;
  captureTarget.addEventListener("keydown", onKeydown, true);
  captureTarget.addEventListener("input", onInput, true);
  ta.addEventListener("blur", onBlur, true);

  // Block xterm's internal _keyDown + CompositionHelper._handleAnyTextareaChanges
  // for keyCode 229 (IME processing). Without this, CompositionHelper reads the
  // textarea value on keydown(229) and sends partial jamo via triggerDataEvent.
  // Returning false from attachCustomKeyEventHandler prevents xterm from
  // processing the keydown at all — our input event handler takes over.
  terminal.attachCustomKeyEventHandler((event: KeyboardEvent) => {
    if (event.type === "keydown" && (event.keyCode === 229 || event.isComposing)) {
      return false; // block xterm's keydown processing for IME keys
    }
    return true;
  });

  return {
    shouldSkip(data: string): boolean {
      // If we're composing, skip any Hangul data that leaks through onData
      if (composing && data.length === 1 && isHangul(data)) return true;
      return false;
    },
    dispose() {
      captureTarget.removeEventListener("keydown", onKeydown, true);
      captureTarget.removeEventListener("input", onInput, true);
      ta.removeEventListener("blur", onBlur, true);
    },
  };
}
