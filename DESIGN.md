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

### Inspector overlay (`고를 곳을 누르세요`)

Pressing `제보` on `/`, `/s/<sid>`, `/boards`, `/p/<id>`, `/issues` or the viewer's `.vbar` starts inspect mode instead of navigating. A toolbar sits at the top center with the hint `고를 곳을 누르세요` and `취소`. On a PC, hovering draws a DevTools-like box over the element under the pointer with a label `tag#id.class W×H`; a click selects it. On touch, a tap (at most 8 CSS px of movement within 500 ms) selects; a drag, a second finger, a scroll or a pinch stays with the page. While picking, no page control fires: no navigation, no button action, no Review mark, no viewer opening. The overlay itself is never a pick target. In the split view a pick inside the thread frame opens the composer in the top page.

### Composer dialog (`문제 제보`)

One native `<dialog>` over the source page: a sheet under 720 px, a centered panel `min(560px, 100vw - 32px)` from 720 px. It never navigates. Contents, in order:

1. Title `문제 제보`.
2. Selection card: a 64 px picture, the element's Korean label, its selector in monospace, and `상위`, `하위`, `다시 고르기`, `빼기`. After `빼기` the card reads `화면 전체`.
3. Picture area: `그림 만드는 중` while the redraw runs, then the picture captioned `화면을 다시 그린 그림` with `그림 빼기`, or `그림 없음`. An uploaded or pasted image replaces it, captioned `올린 사진`.
4. `사진 추가`.
5. Description `설명` (placeholder `무엇이 이상한지 적어 주세요`), the only required field.
6. A status line in text.
7. `보내기` and `닫기`.

There's no title, severity, type or steps field.

### `제보함` list (`/issues`)

Header `제보함`. Reports are listed newest first, 50 at a time with `더 보기`. A row shows the title (a link to the GitHub issue once sent), a relative time, a 64 px thumbnail when there's a picture, and the state as text: `GitHub로 보내는 중`, `보내지 못했습니다 · <reason>` with `다시 시도`, or `#<n> 열림` / `#<n> 닫힘` (just `#<n>` while unknown) plus ` · 댓글 <c>`. A sent row has `처리 맡기기` (`다시 맡기기` after a handoff, then `맡김 · <time>`). With no reports the page reads `아직 제보가 없습니다`. `/issues/new` is the text-only standalone composer with the same texts.

## States

Every state reads as text as well as color. A spinner or hue alone is never the status.

| State | Text | Behavior |
| --- | --- | --- |
| picking | `고를 곳을 누르세요` | Page controls don't fire. Escape, `취소` or Back leaves. |
| idle | `보내기` enabled when the description is nonblank | The description is the only required input. |
| drawing | `그림 만드는 중` | Ends in a picture or `그림 없음`; sending isn't blocked. |
| sending | `보내는 중` | The POST runs; `보내기` is off so one press sends once. |
| stored, waiting for GitHub | `GitHub로 보내는 중` | The report is safe on the PC; the status polls. |
| sent | `GitHub #<n>에 올렸습니다` | Shows `열기` and `처리 맡기기`. Only after GitHub returned the number. |
| failed | `보내지 못했습니다 · <reason>` | Fixed reason text and `다시 시도`. |
| server unreachable | `서버에 보내지 못했습니다` | `다시 시도` resends the same report id. |
| rejected | `내용을 확인해 주세요` / `그림이 너무 큽니다` | 400 / 413; the second offers `그림 빼기`. |
| handing off | `새 세션을 여는 중입니다.` | Then `새 세션에 맡겼습니다.` or a fixed error text. |

## Focus and keyboard

- Entry is a real `<a data-issue-report href="/issues/new">`. Without its page script the link navigates to the standalone composer.
- Picking: Escape cancels and restores the previous selection when re-picking. The page's own tabindex values aren't changed.
- Opening the composer moves focus to the description. Tab and Shift+Tab cycle inside the dialog.
- Escape closes the composer and keeps the draft. Focus returns to the opener when it's still connected, otherwise to the page's `제보` control.
- The reporter adds one history entry while active. Its popstate and Escape handlers run in the capture phase, close only the reporter, and keep the event from the viewer's close handler. The next Back closes the viewer.
- List rows and actions are normal links and buttons with visible focus.

## Hit areas and dark scheme

- Every new control has a hit area of at least 44 CSS pixels, including `취소`, `상위`, `하위`, `다시 고르기`, `빼기`, `그림 빼기`, `사진 추가`, `보내기`, `닫기`, `다시 시도`, `처리 맡기기` and `더 보기`. The existing `--tap: 44px` in `web/thread.html` is the named reference. Entries placed on the existing pages are the exception: the bubble footer's `제보` and the headers' `제보함` and `제보` take the size and style of the controls beside them.
- The overlay, composer and `제보함` follow `prefers-color-scheme: dark` with the dark override values above. They don't alter the palette of `/`, `/s/<sid>`, `/boards`, `/p/<id>` or the viewer, and never force a light dialog over a dark page.
- Motion stays restrained and never replaces text status. Focus rings stay visible in both schemes.
