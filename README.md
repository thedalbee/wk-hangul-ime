# wk-hangul-ime

**Fix Korean (Hangul) IME input for xterm.js in Safari / WKWebView / Tauri v2**

Safari and WKWebView do not fire standard `compositionstart`/`compositionend` events for Korean IME input ([WebKit Bug #274700](https://bugs.webkit.org/show_bug.cgi?id=274700)). This causes xterm.js to receive raw jamo (ㅎㅏㄴ) instead of composed syllables (한).

This module fixes the issue by intercepting WKWebView's `insertReplacementText` input events and managing Korean composition externally, without modifying xterm.js internals.

Based on [xterm.js PR #5704](https://github.com/xtermjs/xterm.js/pull/5704) by minemos, adapted as an external interceptor per maintainer recommendation.

## Install

```bash
npm install wk-hangul-ime
```

## Usage

```typescript
import { Terminal } from "@xterm/xterm";
import { attachWkHangulIme } from "wk-hangul-ime";

const terminal = new Terminal();
terminal.open(container);

// Attach IME handler — call AFTER terminal.open()
const ime = attachWkHangulIme(terminal, (composedText) => {
  // Send composed Korean text to your backend
  ptyWrite(composedText);
});

// In your onData handler, skip leaked jamo
terminal.onData((data) => {
  if (ime.shouldSkip(data)) return;
  ptyWrite(data);
});

// Cleanup when done
ime.dispose();
```

## How it works

WKWebView handles Korean IME differently from Chrome/Firefox:

| Event | Chrome/Firefox | WKWebView |
|-------|---------------|-----------|
| Start composition | `compositionstart` | _(nothing)_ |
| Update composition | `compositionupdate` | `input` with `inputType: "insertReplacementText"` |
| End composition | `compositionend` | _(nothing)_ |
| Initial jamo | _(buffered)_ | `input` with `inputType: "insertText"` |

This module provides three layers of defense:

1. **`attachCustomKeyEventHandler`** — blocks keyCode 229 (IME) from reaching xterm's `_keyDown` and `CompositionHelper._handleAnyTextareaChanges`, preventing partial jamo from being sent via that path.

2. **`stopImmediatePropagation`** on input events (capture phase) — blocks xterm's `_inputEvent` from processing `insertReplacementText` and Hangul `insertText` events.

3. **`shouldSkip()`** — filters any remaining Korean jamo that leak through `onData` during active composition.

## Compatibility

- xterm.js v5.x and v6.x (requires `terminal.textarea` API)
- Safari 17+, WKWebView (macOS/iOS)
- Tauri v2 (confirmed working)
- Does not affect Chrome/Firefox behavior (no `insertReplacementText` events in those browsers)

## References

- [WebKit Bug #274700](https://bugs.webkit.org/show_bug.cgi?id=274700) — Korean composition events not triggered
- [xterm.js PR #5704](https://github.com/xtermjs/xterm.js/pull/5704) — Original fix by minemos
- [xterm.js Issue #3836](https://github.com/xtermjs/xterm.js/issues/3836) — Korean characters not combining on iPad

## License

MIT
