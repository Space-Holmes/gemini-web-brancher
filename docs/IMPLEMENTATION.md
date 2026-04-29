# Implementation Notes

## Branch lifecycle

1. Parent Gemini page inserts a Branch button near the latest model response.
2. User clicks Branch.
3. Parent content script opens Gemini's share UI and extracts a share URL.
4. Background service worker creates an inactive branch tab from that URL.
5. Branch content script detects its branch metadata and clicks "Continue this chat".
6. User writes prompts in the branch panel on the parent page.
7. Background forwards prompts to the branch tab.
8. Branch content script submits the prompt to Gemini and observes the latest model response.
9. Background forwards response snapshots back to the parent page.

## Why a background tab

Chrome MV3 offscreen documents cannot host a full cross-origin Gemini Web session and are intentionally limited. A non-active tab is the most practical extension-native MVP surface.

## Selector strategy

Gemini Web does not provide a stable automation API. The content script uses a small set of text, aria-label, and structural heuristics. Keep those heuristics centralized in `content-script.js` so UI changes are easy to patch.
