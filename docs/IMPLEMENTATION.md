# Implementation Notes

## Branch lifecycle

1. Parent Gemini page inserts a Branch button near the latest model response.
2. User clicks Branch.
3. Parent content script opens Gemini's share UI and extracts a share URL.
4. Background service worker creates a minimized popup worker window from that URL.
5. Branch content script detects its branch metadata and clicks "Continue this chat".
6. User writes prompts in the branch panel on the parent page.
7. Background forwards prompts to the branch worker window.
8. Branch content script submits the prompt to Gemini and observes the latest model response.
9. Background forwards response snapshots back to the parent page.

## Why a minimized worker window

Chrome MV3 offscreen documents cannot host a full cross-origin Gemini Web session and are intentionally limited. A minimized popup worker window is the most hidden extension-native MVP surface that can still run the real Gemini Web app.

Chrome does not provide a supported way for extensions to run a fully invisible third-party page. If minimized popup creation fails in a browser environment, the extension falls back to an inactive tab so the branch can still work.

## Selector strategy

Gemini Web does not provide a stable automation API. The content script uses a small set of text, aria-label, and structural heuristics. Keep those heuristics centralized in `content-script.js` so UI changes are easy to patch.
