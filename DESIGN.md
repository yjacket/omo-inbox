# Design contract: contextual issue reporting

This file records the visual contract for the new issue surfaces. It copies existing tokens by name and value; it does not add tokens or redesign an existing page. The source of truth for behavior is `README.md`; this file is for the visual workers who build `web/issues.html`, `web/issues.js` and the composer/picker additions.

## Existing tokens

New surfaces reuse these names. Do not rename, retune or replace them. Where the same name appears on more than one source page, keep the value of the page whose surface is being extended.

### `web/proposal.html` `:root`

| Token | Value |
| --- | --- |
| `--bg` | `#f4f5f7` |
| `--surface` | `#fff` |
| `--fill` | `#f2f4f7` |
| `--ink` | `#1d2330` |
| `--ink-2` | `#475467` |
| `--muted` | `#667085` |
| `--faint` | `#98a2b3` |
| `--line` | `#e4e7ec` |
| `--line-2` | `#d0d5dd` |
| `--edit` | `#ff2d55` |
| `--mark` | `#1463ff` |
| `--mark-fill` | `rgba(20,99,255,.10)` |
| `--mark-tint` | `rgba(20,99,255,.12)` |
| `--mark-glow` | `rgba(20,99,255,.35)` |
| `--side-bg` | `#f0f6ff` |
| `--side-line` | `#c7dcff` |
| `--side-ink` | `#1d3a6b` |
| `--rec-bg` | `#e7f6ec` |
| `--rec-ink` | `#1f7a45` |
| `--chat-bg` | `#b2c7da` |
| `--chat-mine` | `#fee500` |
| `--chat-ink` | `#191919` |
| `--chat-meta` | `#33445a` |
| `--chat-line` | `rgba(0,0,0,.42)` |
| `--shadow-panel` | `0 12px 32px rgba(16,24,40,.18)` |
| `--shadow-fab` | `0 6px 18px var(--mark-glow)` |
| `--r-xs` | `3px` |
| `--r-sm` | `7px` |
| `--r-md` | `10px` |
| `--r-lg` | `14px` |
| `--r-pill` | `999px` |
| `--s-1` | `4px` |
| `--s-2` | `8px` |
| `--s-3` | `10px` |
| `--s-4` | `12px` |
| `--s-5` | `14px` |
| `--s-6` | `18px` |
| `--s-7` | `20px` |
| `--s-8` | `24px` |
| `--s-9` | `32px` |
| `--frame-min` | `150px` |
| `--fab-inset` | `22px` |
| `--fs-xs` | `12px` |
| `--fs-sm` | `13px` |
| `--fs-md` | `14px` |
| `--fs-base` | `15px` |
| `--fs-lg` | `16px` |
| `--fs-xl` | `19px` |
| `--fs-2xl` | `24px` |
| `--font` | `"Pretendard","Noto Sans KR","Malgun Gothic",system-ui,sans-serif` |
| `--mono` | `Consolas,"D2Coding",monospace` |

### `web/inbox.html` `:root`

| Token | Value |
| --- | --- |
| `--bg` | `#f3f4f6` |
| `--surface` | `#fcfcfd` |
| `--ink` | `#15171b` |
| `--ink-2` | `#5b6069` |
| `--ink-3` | `#6b707b` |
| `--ink-rgb` | `21 23 27` |
| `--accent` | `#b4530a` |
| `--accent-ink` | `#fff7ee` |
| `--ok` | `#1b6e3f` |
| `--ok-rgb` | `27 110 63` |
| `--danger` | `#b42318` |
| `--danger-rgb` | `180 35 24` |
| `--line` | `rgb(var(--ink-rgb) / 0.10)` |
| `--line-soft` | `rgb(var(--ink-rgb) / 0.06)` |
| `--wash-1` | `rgb(var(--ink-rgb) / 0.04)` |
| `--wash-2` | `rgb(var(--ink-rgb) / 0.08)` |
| `--font` | `"Pretendard Variable", Pretendard, "Apple SD Gothic Neo", "Malgun Gothic", "Segoe UI", system-ui, sans-serif` |
| `--mono` | `"Cascadia Code", "JetBrains Mono", Consolas, ui-monospace, monospace` |
| `--fs-title` | `1.375rem` |
| `--fs-row` | `0.9375rem` |
| `--fs-body` | `0.875rem` |
| `--fs-cap` | `0.8125rem` |
| `--fs-micro` | `0.75rem` |
| `--s1` | `4px` |
| `--s2` | `8px` |
| `--s3` | `12px` |
| `--s4` | `16px` |
| `--s5` | `20px` |
| `--s6` | `24px` |
| `--s8` | `32px` |
| `--s10` | `40px` |
| `--r-xs` | `4px` |
| `--r-ctl` | `8px` |
| `--r-row` | `10px` |
| `--r-pill` | `999px` |
| `--t-micro` | `120ms ease-out` |
| `--measure` | `920px` |
| `--ctl-h` | `34px` |
| `--dot` | `8px` |

### `web/thread.html` `:root`

| Token | Value |
| --- | --- |
| `--bg` | `#f3f4f6` |
| `--surface` | `#fcfcfd` |
| `--ink` | `#15171b` |
| `--ink-2` | `#5b6069` |
| `--ink-3` | `#6b707b` |
| `--ink-rgb` | `21 23 27` |
| `--accent` | `#b4530a` |
| `--accent-rgb` | `180 83 10` |
| `--accent-ink` | `#fff7ee` |
| `--ok` | `#1b6e3f` |
| `--ok-rgb` | `27 110 63` |
| `--danger` | `#b42318` |
| `--danger-rgb` | `180 35 24` |
| `--line` | `rgb(var(--ink-rgb) / 0.10)` |
| `--line-soft` | `rgb(var(--ink-rgb) / 0.06)` |
| `--wash-1` | `rgb(var(--ink-rgb) / 0.04)` |
| `--wash-2` | `rgb(var(--ink-rgb) / 0.08)` |
| `--chat-bg` | `#b2c7da` |
| `--chat-mine` | `#fee500` |
| `--chat-ink` | `#191919` |
| `--chat-meta` | `#33445a` |
| `--chat-line` | `rgb(0 0 0 / 0.42)` |
| `--font` | `"Pretendard Variable", Pretendard, "Apple SD Gothic Neo", "Malgun Gothic", "Segoe UI", system-ui, sans-serif` |
| `--mono` | `"Cascadia Code", "JetBrains Mono", Consolas, ui-monospace, monospace` |
| `--fs-title` | `1.375rem` |
| `--fs-row` | `0.9375rem` |
| `--fs-body` | `0.875rem` |
| `--fs-cap` | `0.8125rem` |
| `--fs-micro` | `0.75rem` |
| `--s1` | `4px` |
| `--s2` | `8px` |
| `--s3` | `12px` |
| `--s4` | `16px` |
| `--s5` | `20px` |
| `--s6` | `24px` |
| `--s8` | `32px` |
| `--s10` | `40px` |
| `--r-xs` | `4px` |
| `--r-ctl` | `8px` |
| `--r-row` | `10px` |
| `--r-pill` | `999px` |
| `--t-micro` | `120ms ease-out` |
| `--measure` | `920px` |
| `--ctl-h` | `34px` |
| `--tap` | `44px` |
| `--bubble-max` | `86%` |
| `--composer-h` | `112px` |

### Dark overrides

`web/inbox.html` uses `color-scheme: light dark` and overrides these names under `@media (prefers-color-scheme: dark)`:

| Token | Value |
| --- | --- |
| `--bg` | `#111214` |
| `--surface` | `#191b1f` |
| `--ink` | `#ecedef` |
| `--ink-2` | `#a2a7b1` |
| `--ink-3` | `#8a8f99` |
| `--ink-rgb` | `236 237 239` |
| `--accent` | `#f0a35c` |
| `--accent-ink` | `#1d1206` |
| `--ok` | `#6cc48f` |
| `--ok-rgb` | `108 196 143` |
| `--danger` | `#f08a80` |
| `--danger-rgb` | `240 138 128` |

`web/thread.html` overrides these:

| Token | Value |
| --- | --- |
| `--bg` | `#111214` |
| `--surface` | `#191b1f` |
| `--ink` | `#ecedef` |
| `--ink-2` | `#a2a7b1` |
| `--ink-3` | `#8a8f99` |
| `--ink-rgb` | `236 237 239` |
| `--accent` | `#f0a35c` |
| `--accent-rgb` | `240 163 92` |
| `--accent-ink` | `#1d1206` |
| `--ok` | `#6cc48f` |
| `--ok-rgb` | `108 196 143` |
| `--danger` | `#f08a80` |
| `--danger-rgb` | `240 138 128` |
| `--chat-bg` | `#1b2430` |
| `--chat-meta` | `#c3cfdd` |
| `--chat-line` | `rgb(255 255 255 / 0.18)` |

`web/proposal.html` has no dark `:root` override. The issue surfaces may inherit the dark preference, but must not change any old page's palette. Existing type, spacing, radius and light appearance stay as they are; the issue pages use the shared `--font`, `--mono`, `--fs-*`, `--s*`, `--r-*`, `--line`, `--surface`, `--ink` and `--accent` values from the page they extend.

## Surfaces

### Composer dialog (`문제 제보`)

A native `<dialog>` layered over the source page. It is a sheet at narrow widths and a measured panel at wide widths, never a page navigation. Contents, in order:

1. Title `문제 제보`.
2. Target chip showing the current page/record label, with `바꾸기` and `지우기` (remove target) actions. `위치 선택` is optional.
3. Description field, multiline, focused when the dialog opens. It is the only required field.
4. Attachment summary with `첨부 확인`; empty summary says no attachment. Later optional `사진 추가` / `화면 캡처` appear only when the corresponding input/capability exists.
5. Submission status line using text, never color alone.
6. `보내기` and `초안 버리기`. Closing controls are Escape, Back and a close button.

There is no title, severity, type, steps or expected-result field. No explanatory paragraph stands in for a missing capability. Screenshot capture is offered only when `navigator.mediaDevices?.getDisplayMedia` is callable in the secure current context; it is never invoked automatically.

### Target picker

An explicit picker opened by `위치 선택` or `바꾸기`. It lists adapter-approved visible targets (page, record, control, frame), not arbitrary selectors. Pointer scrolling/panning stays usable; only the chosen activation is cancelled before the source control handles it. Keyboard selection moves through this list with Enter/Space; the source controls' `tabindex` is not changed. Selecting a frame never creates a Review mark. Cancelling returns to the dialog with the previous target and capture generation intact.

### Attachment summary

Shows the final bitmap dimensions, provenance (upload, display capture, source crop, reproduction), mask/mark counts and a preview after explicit acceptance. A rejected file leaves the description and context intact and offers remove/another file. The summary states that the server stores a plain PNG with no metadata; it never shows the original compressed file or implies that an image was captured when it was not.

### `제보함` list (`/issues`)

Header `제보함` with a `제보`/new-report action. The header badge counts only `needs-check` and is independent of Review and `내 차례` counts. Rows show title, state text, category, severity and updated time. Filters cover state and literal search; pagination uses the list cursor. Purged issues do not appear.

### Detail (`/issues/<uuid>`)

The detail keeps these as separate labeled rows: original observation time/build, server receipt time/build, current source link, correction artifact, applied build and the owner's confirmation. Evidence shows a plain PNG through the sanitized image route. Owner actions are `확인` (needs-check to resolved), `다시 열기` (needs-check/resolved to open) and `삭제` (second confirmation naming this issue). Maintainer actions are triage, comment and `수정안 확인` (request-check). A deleted issue becomes a terminal tombstone: content is gone, reads/replays answer 410, and the screen shows the deletion/store history without pretending the report still exists.

## States

All states are conveyed by text as well as color. A spinner or hue alone is never the status.

| State | Text | Behavior |
| --- | --- | --- |
| idle | `보내기` enabled when description is nonblank | No send yet; description is the only required input. |
| draft saved | `초안 저장됨` | Shown only after the IndexedDB transaction completes. Closing/Escape/Back keeps it. |
| save failed | `이 기기에 초안을 저장하지 못했습니다` | Keep current memory state; offer copying the description and an online send without recovery. Never show `저장됨`; sending requires explicit `저장 없이 보내기`. |
| sending | `보내는 중` | Outbox payload/requestId is frozen; no recapture or retarget. Control is locked so one press sends once. |
| pending / uncertain | `접수 확인 중` | A lost or ambiguous response is neither sent nor failed. Resolve by GET of the deterministic issue id, then exact replay. Cancel stops retries without claiming unacceptance. |
| accepted | `접수했습니다` | Receipt received. Show the issue link, clear the outbox payload, restore focus/scroll and stay on the source page. Do not navigate to Inbox or send an ack. |
| conflict | conflict text plus current state and sequence | `key_reused`, `version_conflict`, `store_changed` and `invalid_transition` keep the local text and offer the required explicit next step; never merge or rebase silently. |
| deleted | `삭제됨` plus tombstone history | Content is denied with 410. The tombstone retains no description, context or images. |

Additional composer states: a rejected attachment says why and offers removal/another file; a capture denial/unsupported result yields `visual: none` with the exact reason; `409 store_changed` preserves local content and requires an explicit new report under the new store.

## Focus and keyboard

- Entry is a real `<a data-issue-report href="/issues/new">` in the source page's top tools or the viewer's `.vbar`. Opening the enhanced composer moves focus directly to the description field. If enhancement fails, the link navigates normally and the standalone page shows only a page-level source hint.
- The dialog contains focus while open: Tab cycles inside it, Shift+Tab reverses, and focus cannot reach the inert source page. Any pre-existing inert state is saved and restored.
- Escape closes the reporter. If a nested confirmation is open, Escape dismisses that confirmation first. Closing keeps the draft and returns focus to the immediate opener if it is still connected, otherwise to the page's report control. Scroll is restored to the captured position.
- The reporter adds exactly one history token. While that token is active, its `popstate` and Escape handling runs in the capture phase, closes only the reporter, and stops the event reaching the viewer's generic close handler. The next Back closes the original viewer.
- A breakpoint handoff at 719/720 saves the complete draft before navigation and restores it once in the new top-level owner. If storage is unavailable, suppress only the handoff navigation while the dialog is open and resume it after close; never navigate away from an unsaved draft.
- Picker selection: Enter/Space selects the current keyboard item; click/auxclick is captured before target handlers and cancels activation. Arrow keys move the approved list. Pointer scrolling and panning remain usable.
- List rows and detail actions are normal links/buttons with visible focus. Status text is part of the accessible name or adjacent text, not a color-only cue.

## Hit areas and dark scheme

- Every new control has a hit area of at least 44 CSS pixels, including chip change/remove, close, attachment acceptance, image removal, send, retry, confirm, reopen and delete. The existing `--tap: 44px` in `web/thread.html` is the named reference; do not invent a new name.
- The new surfaces use the inherited `prefers-color-scheme: dark` preference and the dark override values above. They must not alter the palette of `/`, `/s/<sid>`, `/boards`, `/p/<id>` or the viewer, and must not force a light-only dialog over a dark page.
- Motion stays restrained and does not replace text status. Focus rings remain visible in both schemes.
