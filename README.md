# omo-inbox

English | [한국어](README.ko.md)

One phone inbox for everything your omo agent sessions need from you. Each session is a thread. Questions, permission prompts, finished turns, blocked goals and visual boards arrive there as short Korean summaries, and you answer from the PC or the phone. The answer goes back into the session that asked. Node 24, plain ESM, zero npm dependencies, no build step.

## What it does
Every root interactive session (`ctx.mode === "tui"`) becomes a thread. Print, json and rpc runs and child sessions capture nothing. What lands in a thread:

| Kind | Comes from | You can |
| --- | --- | --- |
| `question` | the question tool (`ask-user:asked`) | pick options, write text, or comment |
| `permission` | a `Permission required:` dialog | allow once, deny, or deny with feedback |
| `turn` | a turn that ended and is waiting on you | reply, or tap 계속해 / 승인 / 진행 / 멈춰; or a next action (see Next actions) |
| `blocked` | a goal marked blocked | reply, or a next action |
| `done` | a goal marked complete | reply, or a next action |
| `progress` | each assistant message with text while a work span (episode, see Capture) is open | read; one gray line per message, never pushed, never unread |
| `board` | a visual board of this inbox (the proposal flow below) | open it |
| `notice` | another extension through `inbox:notice` or `inbox notify` | read, open |

- An agent run starting, or you typing in the terminal, moves the thread on: open `turn`, `blocked`, `done`, `progress` and `board` items close as `superseded` (`다음 작업으로 넘어감`). Questions and permissions close only when they are answered, time out or are cancelled. Progress lines stay visible in the thread whatever their status.
- One request is one episode: it gets one gray line per assistant message and one final message (`turn`, `blocked` or `done`) when the work really stops. Waiting on background work or a board is a line, not your turn. In trial mode there is no quiet `board` item; a desk board the session waits on shows on the newest line instead.
- Quitting omo or switching to another session (anything but `/reload`) closes every open item of that thread as `session-closed` (`세션 닫힘`). The thread moves to 끝남 and leaves 🙋, pushes and cache reminders. A reply sent to it waits in the mailbox and is delivered when that session is opened again.
- A phone answer to an open question is fed straight into the waiting question tool. If you answered in the terminal first, the phone answer is dropped and the thread shows the terminal's answer. A question that is no longer waiting gets the phone answer as one follow-up message.
- Each item gets a summary written for someone who didn't watch the session: headline, what the session was doing, the ask, the recommendation when the source has one, and what happens without an answer (see Summaries).
- Visual boards work exactly as in omo-desk: `inbox submit <boardDir>` validates a board folder, keeps a permanent record and prints a URL; the proposal page lets you mark frames, answer questions, comment, ask for a revision (`재요청`) or approve (`승인`); sessions answer with `inbox reply`, `inbox revise` and `inbox close`.
- The owner sees the board concept as **Review**: the Inbox button, the Review list, kind chips, link lines, wait labels, error texts and pushes all say Review. Identifiers keep their names (`board.json`, `visual-board`, `/p/<id>`, `/boards`, `/api/proposals`, the CLI verbs, item kind `board`).
- Whose turn it is. A thread reads 내 차례 when it has an open needs-you item and its session is live. When the session is off, it stays in 내 차례 with a gray `세션 꺼짐` chip only if something still asks: an open question, permission, blocked, notice or board item, a turn or done item whose summary `ask` is non-empty or whose model summary's headline or body still asks a question or names something for you to do (summaries written before `ask` carried to-dos), a turn or done item without a model summary whose final text ends with a question or a to-do, or a stalled-episode final. Otherwise it moves to 끝남. The items stay open, so a session that reconnects puts the thread back in 내 차례 by itself.
- Next actions. Every final (`turn`, `blocked`, `done`) gets a verdict on what's left: `done` (nothing left), `plan` (a plan waits to run), `ship` (uncommitted or unpushed work, or wrap-up), `ask` (it asks you), `blocked` or `stalled`. The thread page turns it into buttons: `세션 닫기`, `새 세션에서 실행`, `커밋·푸시`, `푸시`, up to two model suggestions and actions other extensions register. See Next actions.
- Over Tailscale the same pages are served on `https://<machine>.<tailnet>.ts.net:4388`.

## Install
```powershell
omo install git:github.com/yjacket/omo-inbox
```

That is the normal install. Node 24+ is required.

The first omo session sets up by itself within about a minute. The extension runs `inbox install --from-package` in the background under a lock (`<home>/setup.lock`). Setup copies the clone to `<home>/app`, writes `<home>/app/source.json` (channel `package`, source, sha, version), the launcher, the Run autostart value, the skill copies, the rule and the tailscale 4388 serve handler (behind the 443 guard), then starts the server. Only one setup runs however many sessions start. A failed setup is retried after 10 minutes; the state is in `<home>/setup-state.json` and each run leaves a line in `<home>/logs/install.log`.

Update every git-installed extension with `omo update --extensions` (only this one: `omo update --extension git:github.com/yjacket/omo-inbox`). Within about a minute the next session tick replaces the app and restarts the server, and idle sessions reload onto the new extension.

Remove in two steps. First `/inbox uninstall`: it removes the server, autostart, launcher, app, skills, rule and the 4388 handler, keeps `<home>/data`, and writes `<home>/disabled` so the package stays inert: while it exists, sessions show no footer and never set up or start the server. Then `omo remove git:github.com/yjacket/omo-inbox`. `/inbox install` re-enables a disabled package. If the package is removed without `/inbox uninstall`, the server notices the missing clone and uninstalls itself after 20 minutes (`INBOX_ORPHAN_GRACE_MS`).

Migration. An earlier install made by `install.ps1` or `inbox install` is taken over. While the old `<agentDir>/extensions/omo-inbox.ts` copy exists, the package extension only runs setup. Setup deletes the old copy and sessions reload.

Developer install, for development checks only. `inbox install` from a checkout (or `install.ps1`) still works and records channel `checkout` in `source.json`. The package never overrides it. Run `inbox uninstall` to hand over to the package, and switch back to the git install when you are done.

One line in Windows PowerShell installs from GitHub `main` without a checkout, as a developer install. The script reads a token from `gh auth token` or `GITHUB_TOKEN`, so `gh` must be logged in (`gh auth login`):

```powershell
irm https://raw.githubusercontent.com/yjacket/omo-inbox/main/install.ps1 -Headers @{ Authorization = "token $(gh auth token)" } | iex
```

Piped like this, `install.ps1` downloads `main` into a temp folder, runs the same `inbox install` as below and deletes the folder. It stops with one line when Node is older than 24 or no GitHub token is found. The options below need the checkout form.

From a checkout:

```powershell
.\install.ps1                 # = node bin\inbox.mjs install
.\install.ps1 --no-tailscale  # skip tailscale serve
.\install.ps1 --no-autostart  # skip the HKCU Run value
```

Install copies from the checkout the CLI lives in, not the current directory. Run from the installed copy (`<home>/app`), it refuses before stopping anything.

Steps, in order, each reporting `written | unchanged | skipped | failed:<reason>`:

| # | Step | What happens |
| --- | --- | --- |
| 0 | `stop` | If `/api/health` answers, POST `/api/shutdown` and wait until health fails (up to 5 s). |
| 1 | `app` | Delete `<home>/app`, copy `bin src web extension skill rules package.json` into it. |
| 2 | `launcher` | Write `<home>/launch-hidden.vbs`, which runs node with `--max-semi-space-size=1 --max-old-space-size=128` on `<home>\app\src\server.mjs`, hidden. |
| 3 | `autostart` | `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` value `omo-inbox` = `wscript.exe "<home>\launch-hidden.vbs"`. |
| 4 | `extension` | Copy to `<agentDir>/extensions/omo-inbox.ts`. A package setup instead removes that old copy (`legacy removed\|absent`). |
| 4b | `mode` | Pick `trial` or `primary` (see Modes) and print `mode: <mode>`. |
| 5 | `skill` | Replace `~/.agents/skills/visual-board/` and `~/.claude/skills/visual-board/` with `<app>/skill/`. Skipped in trial mode. |
| 6 | `rule` | Copy `rules/visual-board.md` to `~/.claude/rules/visual-board.md`. Skipped in trial mode. |
| 7 | `config` | Read `tailscale status --json` into `publicBase`, `pcTailnetIps`, `owner`. Tailscale missing or not Running gives `null`, `[]`, `null`. |
| 8 | `tailscale` | Add the 4388 serve handler with the 443 guard (see Tailnet). |
| 9 | `server` | Start with `launchServer()` and wait for `/api/health` (up to 10 s). |

A package setup that finds the same sha already in `<home>/app` does nothing and prints `app: current`. The extension starts the server if it is down.

The last line is `열린 omo 세션에서 /reload 하면 확장이 반영됩니다.` Run `/reload` in open omo sessions.

`<home>` is `OMO_INBOX_HOME` or `~/.omo-inbox`. `<agentDir>` is `INBOX_AGENT_DIR`, `OMO_CODING_AGENT_DIR`, `SENPI_CODING_AGENT_DIR`, `PI_CODING_AGENT_DIR` or `~/.omo/agent`.

`inbox uninstall` shuts the server down, deletes the Run value, removes the extension, both skill dirs and the rule, turns the 4388 handler off with the same guard, removes `<home>/app`, the launcher, `config.json` and `server.json`. It keeps `<home>/data` and prints `data kept: <path>`. When the removed app was a package install, it also writes `<home>/disabled`.

Overrides for tests and sandboxes: `INBOX_USER_HOME` (user home, default `os.homedir()`), `INBOX_RUN_VALUE` (Run value name, default `omo-inbox`), `INBOX_NO_TAILSCALE=1` (install, uninstall and doctor skip every tailscale call), `INBOX_AGENT_DIR` (checked first for `<agentDir>`), `INBOX_ORPHAN_GRACE_MS` (orphan uninstall delay, default 20 minutes).

`inbox uninstall` and `/inbox uninstall` never touch omo-desk.

`inbox doctor` checks health, the Run value, the launcher, the extension matching the app copy (for a package install: the clone's `extension/omo-inbox.ts` equals the app copy and the old `<agentDir>/extensions/omo-inbox.ts` is absent), skill and rule present, the 4388 handler present, no 4388 key in AllowFunnel, and the current 443 Web entry and AllowFunnel deep-equal `config.baseline443`. It prints `<check>: ok|fail <detail>` and exits 0 only when every check is ok.

### Modes, takeover and handback

`config.json` has `"mode": "trial" | "primary"`. `inbox mode` prints it.

- Install picks `primary` when no active omo-desk exists (no `<deskHome>/app/bin/desk.mjs`, or `<deskHome>/disabled` exists) and `trial` otherwise. `<deskHome>` is `INBOX_DESK_HOME` or `~/.omo-desk`.
- Trial runs next to omo-desk. Install prints `skill: skipped (trial)` and `rule: skipped (trial)` and writes neither, so agents keep using desk for boards. Turns that end while desk is holding a board become quiet `board` items, because desk already pushes for them.
- Primary writes the skill and rule. `inbox doctor` checks them only in primary mode, together with `<home>/takeover.json` (or no desk installed).

`inbox takeover` switches from desk to inbox. It needs trial mode and an active desk, else it prints `takeover: skipped (<reason>)`. Steps, one `<step>: <result>` line each:

1. Write `<home>/takeover.json` with the time and desk's `source.json`.
2. Copy every desk proposal missing in `<home>/data/proposals/` and every desk mailbox file into `<home>/mailbox/` (`import: <n> proposals, <m> mailbox files`). Nothing is moved; desk's data stays where it is.
3. Run `desk uninstall`. If it fails, takeover stops with `takeover: failed (desk uninstall)`; the import is harmless.
4. Write `<deskHome>/disabled`, and a shim `<deskHome>/app/bin/desk.mjs` (marker `SHIM.json` `{by: "omo-inbox"}`) that runs the inbox CLI, so old `desk` commands keep working.
5. Set mode primary and install the skill and rule.

`inbox handback` undoes it. It needs `takeover.json` and primary mode. It removes `<deskHome>/app` only when `SHIM.json` names omo-inbox, removes the skill and rule only when they are byte-equal to inbox's copies (else `kept (modified)`), removes `<deskHome>/disabled`, reinstalls desk from its recorded source (package: `install --from-package`; checkout: `install`; unknown: `desk: manual (/desk install)`), sets mode trial and renames `takeover.json` to `takeover-<epochMs>.json`. Boards created while inbox was primary stay in inbox and are not copied back.

## Use (CLI table)
`inbox` isn't on PATH. Agents run `node "<home>/app/bin/inbox.mjs" <command>`; the server and CLI print that exact prefix in their hints. `--json` prints the raw response JSON instead of the human lines.

| Command | Human stdout | Exit |
| --- | --- | --- |
| `submit <boardDir> [--title t] [--note n] [--new] [--session id] [--session-file path]` | `id: <id>`, `url: <url>`, `owner: <id>` or `owner: none` (plus `note: already submitted` when the server returned `existing`) | 0; 1 usage error; 2 invalid board (each error on stderr); 3 server unreachable; 8 duplicate open proposal with different content |
| `revise <id> <boardDir> [--note n] [--session id] [--session-file path]` | `id: <id>` `rev: <n>` `url: <url>` `owner: <id>` or `owner: none` | 0; 1; 2; 3; 4 not found; 5 closed |
| `reply <id> <text...>` (or `--file <path>`, or `-` = stdin) `[--session id] [--session-file path]` | `ok <id> <status>` | 0; 1; 3; 4; 5 |
| `close <id> <summary...> [--session id] [--session-file path]` | `ok <id> closed`, then `record: VISUAL-APPROVED <YYYY-MM-DD> <id> <url>` when the latest feedback verdict is approve, else `record: VISUAL-CLOSED <YYYY-MM-DD> <id> <url>` | 0; 1; 3; 4; 5 |
| `show <id>` | `<title> (<id>) <status> <rev>안`, `url: <url>`, then one block per event (a report board reads `<status> 갱신 <n> report` and its `feedback` block reads `ack`) | 0; 3; 4 |
| `list [--product p] [--feature f] [--status s]` | `<id>\t<status>\t<product.name>\t<branch>\t<title>` per item | 0; 3 |
| `pending [--session id] [--session-file path]` | the pending notice text, or `none` | 0; 1; 3 |
| `wait <id> [--timeout sec]` | `WAITING <id>`; then `FEEDBACK <id> <seq>` + the feedback message, or `CLOSED <id>` | 0; 4; 6 timeout |
| `server status\|start\|stop\|restart` | `running pid=<pid> port=<port> version=<v>` or `stopped` | 0; 7 stopped (status) |
| `notify --producer p --key k --title t [--body b] [--urgency now\|soon\|fyi] [--session id] [--expires iso]` | `ok <itemId>` | 0; 1 usage error; 2 invalid notice (each detail on stderr); 3 server unreachable |
| `threads [--status s]` | `<status>\t<title>\t<product>\t<branch>\t<headline>` per thread | 0; 3 |
| `mode` | `trial` or `primary` | 0 |
| `takeover` | `<step>: <result>` lines (see Modes) | 0 switched; 1 skipped or failed |
| `handback` | `<step>: <result>` lines | 0 switched; 1 skipped or failed |
| `install [--from-package] [--no-tailscale] [--no-autostart]`, `uninstall`, `doctor` | `<step>: <result>` lines | 0 ok; 1 any failed |

Exit 8 prints `open proposal exists: <id> <url> - use: inbox revise <id> <boardDir>, or inbox submit --new` on stderr.

`submit` and `revise` send the absolute board dir and the identity of the current directory; the server validates. Before talking to the server the CLI runs `ensure`: GET `/api/health` (1500 ms timeout). A foreign answer exits 3. On a version mismatch the CLI restarts the server (`/api/shutdown`, then a relaunch) only when the installed app's version equals the CLI's. Otherwise it warns `server version <x> differs from cli <y>; run install to update` and keeps using the running server. No answer launches the server, then up to 20 health checks. `INBOX_URL` overrides the base URL, `INBOX_NO_ENSURE=1` skips launching, `INBOX_WAIT_POLL_MS` (default 2000) and `INBOX_ENSURE_POLL_MS` (default 500) set poll intervals.

Caller identity. `--session <id>` and `--session-file <path>` name the calling session explicitly. The session ID resolves as: explicit `--session` > `INBOX_SESSION` > `PI_SESSION_ID` > null. Without either option the env behavior is unchanged. `--session` alone records the file as null; `--session-file` is recorded exactly as given, and alone it keeps the ID resolution above. Paths are never read or inferred. A missing or blank value, or a value that starts with `--` (it would eat the next option), is a usage error: exit 1, checked before `ensure` and before any network call. Other option parsing, unknown options and accepted ID formats don't change. `sessionOf` is the CLI's single ownership resolution point: `submit` sends it as `identity.session`, `revise`, `reply` and `close` send it as `session`, `pending` queries with it. `submit` and `revise` print `owner:` from the server's `summary.owner`; `--json` output is unchanged.

Ownership. An unchanged resubmit (same hash, `existing`) keeps the existing owner, revision and event count, even when it's ownerless. An explicit `revise` from another session may move ownership; nothing takes it over automatically. Manual use without any session stays allowed and leaves the board ownerless. Env vars don't always cross process boundaries (a monitor lane or a stripped shell may lose `INBOX_SESSION`), so agents in such lanes pass `--session` themselves. `pending --session <id>` calls `/api/here` with that id, so it also counts that session as live (a session is live when it called `/api/here` within 90 s). The cwd identity is still the existing product key (`dir/<name>` without a remote). Source changes reach real sessions only after the installed copy is updated (`inbox install`, then `/reload` or restart).

On Windows the server is created through `Win32_Process.Create` (PowerShell, hidden) so it outlives the caller's terminal. If WMI fails, or any env key starts with `OMO_INBOX_` or `INBOX_`, it falls back to a detached `spawn`.

## Board format
A board is a folder with `board.json` (schema `visual-board/1`) and the files it references.

```
{ title: string (required, non-empty),
  lead?: string,
  sections?: [{ title: string, desc?: string,
    cards: [{ badge?, title?, layout?: 'one'|'two'|'', diagram?: boolean, gray?: boolean, note?, say?,
              frames: [[label, path], ...] (>= 1) }] }],
  questions?: [{ id: /^[A-Za-z0-9_-]{1,40}$/ unique, text, help?,
    options: [{ value: /^[A-Za-z0-9_.-]{1,60}$/ unique in the question, label, rec?: boolean, why? }] (>= 2) }],
  commentPlaceholder?: string,
  kind?: 'decision'|'report' }
```

- `kind` is `decision` when absent. Any other value is an error naming `kind`. A `report` board is a question-less completion report: any `questions` entry makes it invalid, with an error naming `questions`.

- Strict: any other key is an error. The prototype's top-level `id` is ignored and `sideSession` (string) shows as a gray note above `정할 것`.
- Frame labels are unique across the whole board; marks reference frames by label.
- `say` (card) is what `듣기` says for the card after its title, instead of its note: the pictures explained for the ear, in Korean.
- Up to 60 frames and 30 questions. A board needs at least one frame or one question.
- Frame paths are local files only. URLs and absolute paths are errors (`download the image into the board dir`), so the record keeps every picture it showed. Relative, forward slashes, no `:`, no empty / `.` / `..` segment, at most 200 chars, extension `.png .jpg .jpeg .gif .webp .svg .mmd`, a regular file inside the board dir.
- Collected files: `board.json`, every referenced frame, and for each `x.svg` its sibling `x.mmd` if it exists. The folder is never walked. Each file at most 20 MiB, total at most 100 MiB.
- Errors are English, one per line, prefixed with the JSON path, e.g. `questions[1].options: must have at least 2 options`.

See `skill/example/` for a working board.

## Inbox pages
### Threads list (`/`)

The header has `Inbox`, the `알림 받기` button, a **Review** button and `🙋 N` (threads in 내 차례, hidden ones not counted). The Review button carries a round badge with the number of Reviews waiting on you (`reviews.mine`, report Reviews included); there's no badge at 0, and it refreshes with the 5 s list poll. One row per thread: title, product and branch, status (chip `🙋 내 차례`, or `⛔ 막힘` when the newest item is blocked and `🔔 알림` for a notice, plus a gray `세션 꺼짐` chip when the session is off), the newest item's headline and time, unread count and a 🔥 badge while the prompt cache is warm. Threads that need you come first (oldest waiting first), then working, then ended (newest first). The section of threads that need you is titled `내 차례`. Hidden threads appear only in a last group `숨긴 대화 N`, folded by default; `펼치기` / `접기` toggles it and the open state is kept per browser in `localStorage` key `inbox.hiddenOpen`. A 내 차례 row with a next verdict gets a gray chip right after the status chip: `할 일 없음` (done), `실행 대기` (plan) or `마무리 남음` (ship). An ended row whose session quit with a plan or ship verdict gets the same chip. Ask, blocked and stalled rows get none.

A thread's title is the session name when it is Korean, else a model-written Korean title of your first request (omo names sessions in English, so this is the usual case), else `요청: <first request>` clipped to 24 characters. Notices without a session go to the `알림` thread.

Split view. A window at least 720 CSS px wide (`min-width: 720px`) is wide; anything narrower is narrow (phones, a folded Galaxy Z Fold). On a wide window `/` shows two panes across the full width: the list on the left at a fixed 340 px with its own scroll, and an `<iframe>` with `/s/<sid>` of the selected thread filling the rest, borderless and full height. The selection lives in the URL as `/?s=<sid>`, and a hash is kept (`/?s=<sid>#<itemId>` loads `/s/<sid>#<itemId>`). A row tap doesn't navigate the page: it pushes `/?s=<sid>` with `history.pushState`, loads the frame and marks the row selected (`aria-current="page"`), so back walks through earlier selections. The selection survives the 5 s poll. Without `?s=` the first row is selected (`history.replaceState`); an empty list leaves the right pane empty. A `?s=` not in the list still loads, and the thread page shows its own not-found state. On a narrow window `/` is the single list as before, and a URL with `?s=<sid>` is replaced by `/s/<sid>` plus its hash. Only threads split: Reviews (`/boards`, `/p/<id>`) stay full-page pages at every width.

### Thread page (`/s/<sid>`)

- Top bar: `‹ Inbox`, the title, a product·branch chip, the status chip (`🙋 내 차례` when it's your move, `⛔ 막힘` when the newest item is blocked), a gray `세션 꺼짐` chip when the session is off, and the 🔥 badge. A **숨기기** button sits left of `과정 보기`; on a hidden thread it reads **숨김 해제**.
- Agent bubbles (left, white): kind chip (질문 / 승인 요청 / 권한 요청 / 보고 / 막힘 / 끝남 / 진행 / 알림 / Review), bold headline, gray `하던 일 · <context>`, the body, the ask, option buttons (★권장 first with its reason; multi-select questions use checkboxes plus 보내기; each question has a 직접 쓰기 field), a gray `답이 없으면 · ...` line, and a footer with 듣기, 원문 보기 (the raw text rendered as Markdown: headings, lists, quotes, tables, code, bold, italic and https links; HTML in it stays literal text), 더 쉽게 (asks for a simpler summary), 제보 (reports a problem with this message) and the time.
- Your bubbles (right, yellow): what you sent and its state: `보내는 중`, `전달됨 ✓`, `늦게 전달됨`, or `세션이 꺼져 있어 다시 열면 전달됩니다`. A message the session queued while it holds new turns reads `세션이 멈춰 있어 터미널에서 재개하면 처리됩니다` (after Esc/Stop) or `세션이 중단됐다 다시 열려 터미널에서 재개하면 처리됩니다` (a session reopened after it died mid-run); it runs after terminal input or `/resume`. An answer still unconfirmed after 60 s offers 다시 보내기.
- System lines (center, gray): `터미널에서 답함`, `다음 작업으로 넘어감`, `시간 초과`, `Review · 열기`. Each progress item is one gray line `<headline>` without a background, shown whatever its status, so the lines of an episode stay above its final message.
- More system lines: a close as `closed-by-owner` reads `닫음`, as `handed-off` reads `새 세션으로 넘어감`. After a new-session launch the thread shows `새 세션을 여는 중`, and once the new session connects, `새 세션에서 이어감 · 열기` linking `/s/<new sid>`.
- The header toggle `과정 보기` (default on, kept in `localStorage` key `inbox.progressLines`) hides or shows the progress lines.
- While the session waits, the newest line gets ` · 기다리는 중: <label>` (백그라운드 작업, 모니터, 분리 실행 작업, 하위 작업, 작업 흐름, Review 답, 질문 답, 권한 답, 목표 이어가기, 다시 불러온 뒤 확인; a hold `hold:<source>` reads as its source; any other reason reads 다음 신호) and, for each desk board it waits on, `<title> · 열기` opening the board in a new tab.
- 원문 보기 of an episode final fetches the episode and lists every message of the span in order, each with its time and rendered as Markdown; a failed fetch shows `다시 시도`. Items without `meta.episode` show their own raw text as before.
- Composer at the bottom: quick chips 계속해 / 승인 / 진행 / 멈춰 (when the newest open item is a turn, blocked or done item, or the thread is working), a `답장` box and 보내기. It answers the newest open item that needs you (a question gets a comment, a turn gets a reply), or sends a free message when none is open.
- Next line: the bubble of the newest open final whose next state is done, plan, ship, blocked or stalled shows `다음 · <reason>` after the ask line. Ask finals get no next line.
- Next actions bar: for done, plan and ship the four chips are hidden and the next actions take their place, the primary one in the accent color. For ask, blocked and stalled the chips stay, followed by the provider actions and a ghost (outline) `세션 닫기` set apart by a gap. A tap locks every next button until the reply. They share the chips' row, size and shape.
- A continue action (`커밋·푸시`, `푸시`, model and provider prompts) is sent like a reply, so the session's next run supersedes the final and the composer returns to the working chips. On an off session it opens the reopen sheet first.
- Close sheet: a close with warnings, or a server answer `confirm_required`, opens `세션을 닫을까요?` listing each warning, with `닫기` and `취소`. Without warnings close posts at once. Status `세션을 닫는 중입니다.` (live session) or `세션을 닫았습니다.` (session off).
- New-session sheet: always asks `새 세션에서 실행할까요?` with `폴더 · <dir>`, `첫 메시지 · /skill:ulw-execute <slug>`, `실행` and `취소`. Status `새 세션을 여는 중입니다.`, then `새 세션을 열었습니다.` with `열기` to the new thread.
- Action errors: `계획 파일을 찾지 못했습니다.` (plan_missing), `상황이 바뀌었습니다. 다시 확인해 주세요.` (stale, the page refreshes at once), and the reopen texts `세션 폴더가 없어 열지 못했습니다.`, `터미널을 찾지 못했습니다.`, `세션을 열지 못했습니다.`, `이 기기에서는 열 수 없습니다.`. An action bubble still unconfirmed after 60 s reads `세션이 응답하지 않습니다` instead of offering 다시 보내기.
- A session that quit (the actionable closed final, see Next actions) keeps its plan and continue actions in the composer area until a handoff exists; continue goes through the reopen sheet.
- Terms: each summary term that appears in the headline, `하던 일`, body or ask is a dotted-underlined button. A tap opens a popover with its meaning just under the term, inside the bubble. Another tap, a tap outside or Escape closes it and focus returns to the term. Only one is open at a time, and it stays open across the poll re-render. There is no `용어 ·` line.
- 듣기 comes first in every agent bubble footer. A tap reads the headline, `하던 일` with its context, the body, the ask and the choices the bubble shows (each question's text, then number, label, 추천 and why; permission buttons by name) in Korean (ko-KR); the button reads 멈추기 while it speaks and 듣기 again at the end. Starting another message stops the first, so only one plays. Nothing plays without a tap, and the button is hidden when the browser has no speech.
- Reopen sheet: sending anything to a thread whose session is off (composer, quick chips, option picks, permission buttons, feedback or reply, 다시 보내기) first opens a sheet titled `세션이 꺼져 있습니다` with the line `다시 열면 이 답을 바로 전달합니다.` and two buttons, `다시 열고 보내기` and `나중에 전달`. Escape or a tap on the dim area closes it without sending and keeps the typed text. `나중에 전달` stores the reply as before. `다시 열고 보내기` stores it the same way and, only when that worked, asks the PC to reopen the session (see Session wake and capture). The composer status then reads `세션을 여는 중입니다.` and then one of: `세션을 열었습니다. 연결되면 전달됩니다.`, `세션 폴더가 없어 열지 못했습니다. 답은 다음에 열 때 전달됩니다.`, `열 세션을 찾지 못했습니다. 답은 다음에 열 때 전달됩니다.`, `터미널을 찾지 못했습니다. 답은 다음에 열 때 전달됩니다.`, `세션을 열지 못했습니다. 답은 다음에 열 때 전달됩니다.` or `이 기기에서는 열 수 없습니다. 답은 다음에 열 때 전달됩니다.`; it is empty when the session turned out to be live. 더 쉽게 is not gated. A failed hide shows `숨기지 못했습니다.` there.
- The page polls `GET /api/threads/<sid>?since=` every 3 s while visible. Session text is always set as text, never as HTML.
- Loaded as the top window on a wide window (at load or when the width changes), the page replaces itself with `/?s=<sid>` plus its hash, so notification taps land in the split view. Inside the split frame it's embedded: `<html>` gets `data-embed`, `‹ Inbox` is hidden, and links to other pages (`/p/...`, `/boards`) open in the top window (`<base target="_top">`; `target="_blank"` links keep it). The embedded page never redirects. Everything else works as above.
- When the question tool can't be reached from the phone, the bubble says `터미널에서 답해 주세요`; after a reload it says `리로드 후에는 터미널에서 답해 주세요`, and a phone answer becomes a follow-up message.

New pages send `Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'self'`.

### Proposal page (`/p/<id>`)

The Review list lives at `/boards` (title and heading `Review`, tab title `(N) Review`, status filter and chip `🙋 내 차례`). The page names Reviews as Review in its texts (`이 Review를 AI와 이야기하기`, `이미 끝난 Review입니다.`, `Review를 찾을 수 없습니다.`). A proposal page whose owner session is known has a `‹ 대화` link to that thread.

- Inline frames: a mouse or pen drag on a frame draws a numbered box right there. Touch never draws inline, so a finger over a frame scrolls the page.
- Tap or click a frame without dragging (under 8 px of movement) and the frame opens full screen in the viewer. It works for pictures and for rendered `.mmd` diagrams.
- The viewer is a dialog over the page with a top bar: the frame label, `표시하기` and `닫기`. The picture starts fitted to the screen. Two fingers pinch-zoom (1x to 8x) around the midpoint, one finger or a mouse drag pans, the mouse wheel zooms around the cursor. The picture can't be dragged off the screen.
- `표시하기` arms one box: one finger or the mouse draws it (two fingers still pinch), then the button turns off again. A box made here is the same as an inline one: normalized to the picture, numbered, listed under `표시한 곳`, sent with the feedback with its crop.
- Boxes of this frame are drawn in the viewer. Tap one to select it; a new box starts selected. The bottom of the viewer then shows its number, a comment field and `지우기`. The comment is the same one the `표시한 곳` list shows, and `지우기` removes the box everywhere. Tap outside the box to put the sheet away. When the on-screen keyboard opens, the sheet moves above it.
- On a past revision or a closed proposal the viewer still opens for zoom and pan, but has no `표시하기` and no sheet.
- From revision 2 on, a `이 안이 나온 이유` card (report boards: `이 갱신이 나온 이유`) sits between the title and the lead. For the revision on screen it lists what led to it, in order: your feedback on the previous revision, the session's replies, then the revise note, in the same rows as `대화`, which still lists every event at the bottom. Revision 1 has no card, nor does a revision with no feedback, reply or note before it.
- `대화` and the `이 안이 나온 이유` card read like a chat on a light-blue background: your feedback (answers, comment, boxes) in yellow bubbles on the right without a name, the session's replies in white bubbles on the left headed `🤖 세션 답`, and submitted, revised and closed as small centered lines with their note in a gray pill.
- `재요청` sends your answers, comment and boxes and asks the session for a revised board; it needs at least one of them. `승인` sends the same and approves the proposal: the session does the work without showing it again and closes it. Only an approval is tagged in the conversation. Both buttons lock on the first press, so one press sends once; a successful send goes back to the inbox, a failed one stays on the page with the reason. There is no close button: the session closes the proposal with `inbox close` when the work is done.
- Report boards (`kind: report`) show one `확인` button instead of `재요청` and `승인`. It sends verdict `ack` with your comment and boxes. The header shows a `보고` chip, revision tabs, event tags and the new-revision banner read `갱신 n` instead of `n안`, and the `정할 것` card reads `확인` with no questions. A summary without `kind` renders as a decision board.
- The inbox shows a `보고` chip and `갱신 n` on report boards, a `보고 N` count, and groups open report boards under their own heading after the decision boards.
- Close with `닫기`, Esc or the phone's back gesture. The viewer is one history entry, so back closes it and the page stays where it was.
- `듣기` next to the title reads the open revision aloud with the device's own voice (Web Speech `speechSynthesis`, Korean). Order: the session's reply when it is the newest event; from revision 2 on, the `이 안이 나온 이유` card (each feedback and reply in it, then the revise note); the title; the lead; each section title, then each card's title and its `say` (else its note); each question with its options, saying which one is recommended and its `why`; then `여기까지입니다`. While it reads, the button says `멈추기` and a floating `멈추기` at the bottom left stays on screen as the page scrolls; the card being read is outlined and scrolled into view. When reading stops partway (`멈추기`, a speech-engine error, or the engine going silent while the page was in the background), the button says `이어 듣기` and goes on from the piece it was reading, and `처음부터` next to it reads from the top. Reading to the end returns it to `듣기`. Switching revision stops it and forgets the place.
- To answer by voice, use the phone keyboard's microphone in `전체 의견`. One comment can answer every question.

### Issue pages (`/issues`)

- Entry. `제보` is a real `<a data-issue-report href="/issues/new">` in the top tools of `/`, `/s/<sid>`, `/boards`, `/p/<id>`, `/issues` and in the fullscreen viewer's `.vbar`; the bubble footer's `제보` button opens the composer on that bubble. The page script turns an unmodified primary click into inspect mode. The anchor still navigates to `/issues/new`, which needs its page script; that page is the text-only composer.
- Inspect mode. A toolbar at the top center reads `고를 곳을 누르세요` with `취소`. On a PC, hovering draws a DevTools-like box and a label `tag#id.class W×H`, and a click selects. On touch a tap (at most 8 CSS px of movement within 500 ms) selects; a drag, a second finger, a scroll or a pinch stays with the page. While picking no page control fires: no navigation, no button action, no Review mark, no viewer opening. Native scroll and pinch keep working, but the viewer's own pan and zoom pause, so zoom first and then press `제보`. Escape, `취소` or Back leaves the mode. In the split view a pick inside the thread frame opens the composer in the top page.
- Composer. One dialog: a sheet under 720 px, a centered panel `min(560px, 100vw - 32px)` from 720 px. In order: the title `문제 제보`; the selection card with a 64 px picture, the element's Korean label, its selector in monospace and `상위`, `하위`, `다시 고르기`, `빼기` (`빼기` drops the element and the card reads `화면 전체`); the picture area; `사진 추가`; the description `설명` (placeholder `무엇이 이상한지 적어 주세요`, focused on open, the only required field); a status line; `보내기` (off while the description is blank or a send runs) and `닫기`. `다시 고르기` keeps the text, and Escape while picking again restores the previous selection. The description is a draft in `localStorage["inbox.reportDraft"]`: it survives close and reload and is removed once the report is on GitHub.
- Picture. The picture is now an automatic redraw of the chosen element shown before sending, which replaces the old rule "never a DOM reconstruction". While it's made the area reads `그림 만드는 중`; then it shows the picture captioned `화면을 다시 그린 그림` with `그림 빼기`, or `그림 없음` when the redraw failed. `사진 추가` or pasting an image replaces it with an uploaded picture captioned `올린 사진` (each side at most 4096 px, at most 2,097,152 px). A PNG over 8 MiB is exported once more at half the pixels before sending.
- Sending. `보내기` stores the report on the PC first; GitHub gets it in the background, so a send survives a GitHub outage or a server restart. Status: `보내는 중` while the POST runs, `GitHub로 보내는 중` while it waits for GitHub, `GitHub #<n>에 올렸습니다` with `열기` and `처리 맡기기` only after GitHub returned the number, `보내지 못했습니다 · <reason>` with `다시 시도` on a hard failure. A network error or 5xx on the POST shows `서버에 보내지 못했습니다` with `다시 시도`, which resends the same report id. A 400 shows `내용을 확인해 주세요`, a 413 `그림이 너무 큽니다` with `그림 빼기`. If the text or picture changed after a failed send, the server answers `key_reused` and the composer resends once under a new id. A 403 shows `이 기기에서는 보낼 수 없습니다`, an unreadable picture `사진을 읽지 못했습니다`, and a failed `다시 시도` `다시 시도하지 못했습니다.`.
- `제보함`. `/issues` lists reports newest first, 50 at a time with `더 보기`. Each row has the title (a link to the GitHub issue once sent), the relative time and the state: `GitHub로 보내는 중`, `보내지 못했습니다 · <reason>` with `다시 시도`, or `#<n> 열림` / `#<n> 닫힘` (just `#<n>` while the state is unknown) plus ` · 댓글 <c>` when there are comments. A row with a picture shows a 64 px thumbnail. With no reports it reads `아직 제보가 없습니다`. The list polls every 5 s while a row is pending, and when GitHub states are older than 60 s it fetches again after 3 s, at most 5 times per page load. `/issues/new` is the standalone composer: heading `문제 제보`, `설명`, `보내기` and the same status texts, without element or picture. Any other `/issues/<...>` redirects to `/issues`. The header `제보함` badge counts pending plus failed reports (`보내지 못했거나 보내는 중인 제보 <n>건`) and hides at 0. A list that can't load reads `목록을 불러오지 못했습니다.` with `다시 시도`, and a failed row retry reads `다시 시도하지 못했습니다.`.
- Handoff. A sent row has `처리 맡기기` (`다시 맡기기` after a handoff). It starts a new agent session in the destination repo's folder: `새 세션을 여는 중입니다.`, then `새 세션에 맡겼습니다.`, and the row shows `맡김 · <time>`. Errors read `이 저장소의 폴더를 찾지 못했습니다.`, `터미널을 찾지 못했습니다.`, `세션을 열지 못했습니다.` and `아직 GitHub에 올라가지 않았습니다.`. The folder is `reports.folder` when it exists. Otherwise it's the worktree or cwd of a thread whose product is the destination repo, preferring branch `main` or `master`, then the newest; it's never inside the Inbox home, `<home>/app` or `~/.omo/agent/git`.
- Entries on existing pages take the size and style of the controls beside them. Every control has at least a 44 CSS-pixel hit area, every state reads as text and not color alone, and the new surfaces follow the dark preference.
- Legacy. On first start, open reports of the old `data/issues/` store become reports with their original time and go to GitHub marked `이전 제보함에서 옮긴 제보입니다`. Resolved and deleted ones are skipped, and the old files stay as they are.

#### GitHub

- Destination. `config.json` `reports.repo` (default `yjacket/omo-inbox`), label `reports.label` (default `inbox-report`, created when missing), pictures on the branch `reports.assetsBranch` (default `inbox-report-assets`) at `reports/YYYY/MM/<id>.png`. Only a private repo with Issues turned on is accepted. The default `yjacket/omo-inbox` is public, so reports fail with `public_repo` until `reports.repo` names a private repo.
- Token. `GH_TOKEN`, then `GITHUB_TOKEN`, then `gh auth token`. It needs classic `repo`, or fine-grained `Issues: write`, `Contents: write` and `Metadata: read` on the destination repo.
- Issue. The title is the description's first non-blank line (at most 80 code points, `…` when cut). The body holds the description, route and URL, element label, selector, DOM path, visible text, frame, source (`- 출처:`) and product (`- 제품:`), rect, viewport, scroll, DPR, color scheme, pointer, server build, the inline picture with a file link, a JSON block and the hidden marker `<!-- inbox-report:<id> -->`.
- Delivery. One report at a time. Network errors, 5xx and rate limits are retried with backoff. A create whose answer got lost waits, then searches for the marker before creating again, so a report never makes two issues. Hard failures stop with a fixed reason: `GitHub 인증을 확인해야 합니다`, `GitHub 토큰이 없습니다`, `저장소에 쓸 권한이 없습니다`, `저장소를 찾을 수 없습니다`, `저장소의 Issues가 꺼져 있습니다`, `공개 저장소에는 올리지 않습니다`, `GitHub가 내용을 받지 않았습니다`, `그림 파일이 이미 다르게 올라가 있습니다`, and `GitHub에 연결하지 못했습니다` once retries run out.
- Processing kickoff. `처리 맡기기` gives the new session `inbox-report <owner>/<repo>#<n>` as its first message.
- Env overrides for tests and QA: `INBOX_GITHUB_API` (default `https://api.github.com`), `INBOX_GITHUB_TIMEOUT_MS` (per request, default 20000), `INBOX_REPORT_RETRY_MS` (backoff base, default 5000), `INBOX_REPORT_RECONCILE_MS` (wait before searching for a lost create, default 60000).

## Data layout
```
<home>/
  app/                 installed copy of the repo
  data/proposals/<id>/ the record (the server is its only writer)
    proposal.json      { v: 1, id, title, created, product, feature, session, kind }, written once and last
    revs/<n>/...       copied board files per revision
    events/<seq6>-<type>.json
    crops/<seq6>-<n>.png
  data/threads/<sid>/  one folder per session thread
    thread.json        { v: 1, session, cwd, product, feature, worktree, branch, title, titleSource, firstRequest, created, ended, sessionFile, hidden }
    events/<seq6>-<type>.json   item, summary, answer, delivered, bridge, state, pushed, closed, activity, cache, read, next, actions, handoff
  data/reports/<id>/   one folder per report (the server is its only writer)
    report.json        { v: 1, id, createdAt, fingerprint, report, image, asset, issueRequest, delivery, github, handoff, legacy }
    image.png          the picture, when the report has one
  data/issues/         the old issue store, read once for migration and kept as it is
  data/live.json       session -> last /api/here time (epoch ms), restores liveness after a server restart
  mailbox/<session>/<file>.json   answers and board feedback waiting for the extension, deleted after delivery
  ledger/<session>.json   delivery ids the extension already handled
  control/<session>/<deliveryId>.json   session-control files (close, run) waiting for the extension
  takeover.json        written by takeover, renamed by handback
  push/vapid.json      the server's VAPID key pair, created once
  push/subscriptions.json   browsers that turned notifications on
  logs/  config.json  server.json  launch-hidden.vbs
```

Threads:

- Item ids are `i-YYMMDD-xxxxxx`. Kinds `question permission turn blocked done progress board notice`; policies `needs-you progress quiet fyi`. The `_notices` thread holds notices without a session.
- Episode items carry `meta.episode`. A line (`progress`) has `{key, seq, opener, openedAt}`; a final has `{key, opener, openedAt, closedAt, closeReason, lines, turns, interjections, questions}`. The key is `e:<sid>:<stamp of the last transcript entry when the episode opened>`, so every copy of the extension derives the same one.
- A `state` event `{state: "waiting"|"resumed", reasons, boards}` records why a line waits; the item exposes the latest one as `item.state`. A `pushed` event records that an item's push was sent, so a server restart never pushes it again.
- An `activity` event stores `cause` (`owner` or `system`; missing reads as `owner`).
- Item status: `closed` when closed; else `answered` when an answer has no matching `delivered`; else `delivered`; else `open`. Questions and permissions still open after 24 h read as closed `expired`.
- `thread.json` keys `sessionFile` (string or null, default null; the session file the extension reported, used by reopen) and `hidden` (boolean, default false). An older thread.json without them reads as null and false.
- `thread.json` key `executes` (string or null, default null): the plan slug this session runs itself, seen in its raw first input. A `next` event `{itemId, next}` stores a final's verdict, an `actions` event `{producer, actions}` a provider's list, and a `handoff` event `{itemId, to, via, status, slug}` a new-session launch (`via` `orca`, `wt` or `sink`; `status` `launching` or `connected`).
- Close reasons add `closed-by-owner` (`닫음`) and `handed-off` (`새 세션으로 넘어감`) to `session-closed` (`세션 닫힘`).
- Thread status. A session is live when it called `/api/here` within 90 s, or sent a plain bye (`/reload`) within 90 s. `needs-you` when an open needs-you item exists and the session is live, or when the session is off and an open item still asks (see What it does); else `working` when live; else `ended`. Rows and the thread view carry `live`, `off` (needs-you while not live, never for `_notices`) and `hidden`.
- `delivered.how` is `bridge`, `message`, `late-message`, `dropped` (the terminal answered first), `refused` or `control` (a session-control file was applied). A message admitted while `ctx.getPauseState()` reports a hold is acked with detail `held:stop` (Stop, or an inherited hold) or `held:interrupted` (the `interrupted-run` hold).
- Mailbox files are `{v:1, type, ...}`: `item-answer` (itemId, kind, deliveryId, payload, text), `explain` (itemId), or `board-feedback` (desk's payload; a file without `type` is board feedback).

Proposals:

- Ids are `YYMMDD-xxxx`. Every JSON write goes through a temp file and a rename. A revision is copied into `revs/<n>.tmp-<rand>` and renamed when complete; index rebuild ignores dirs without `proposal.json` and `*.tmp-*` dirs.
- Events: `submitted`, `feedback`, `reply`, `revised`, `closed`, numbered from 1 and never reused. `submitted` and `revised` carry a content `hash`.
- Status: any `closed` gives `closed`; otherwise, skipping session replies, a last `feedback` gives `theirs` (your feedback is waiting on the session, `approved` if the verdict was approve) and anything else gives `mine` (waiting on you). A reply never changes the status: after feedback the proposal stays `theirs` until the session revises or closes it. The pages show them as `끝남`, `🤖 처리 중` and `🙋 내 차례`.
- Owner is the session id of the latest event that has one.
- `kind` is written to `proposal.json` at submit and shown as `kind` in every summary; records without it read as `decision`. A revise keeps the kind; a revise whose board has a different kind is 400 `bad_input`.
- Verdicts: `change` and `approve` on decision boards, `ack` on report boards only (optional comment and marks, no answers). Any other pairing is 400 `bad_input`. An `ack` without comment and marks writes the feedback event, then a `closed` event `{ by: "user", summary: null }` in the same call, and writes no inbox file. Its feedback `delivery` is `none` because there is nothing to deliver. An `ack` with a comment or a mark writes only the feedback event: status becomes `theirs`, it's routed and delivered through the usual inbox and pending-notice path, and the owning or next session closes it with `inbox close`.
- Submitting the same feature + title again while open returns the existing proposal when the content hash matches, otherwise exit 8. `--new` always creates.
- Feedback `delivery` is computed: `none` (no owner, nothing to deliver (an `ack` without comment and marks), or the inbox write failed: the event is stored, the server retried once and logged it), `pending` (inbox file present), `delivered`.
- The delivered text (the inbox file's `text`, which `inbox wait` prints too) ends with a `처리:` line. After a `재요청` it tells the session to answer with `inbox revise` and that a 재요청 is not an approval, so the session neither calls the decision final nor starts the work. After `승인` or `확인` it lists `reply / revise / close`.
- Product key comes from the normalized `origin` remote (lowercased `host/path`), feature key is `<product key>#<branch>`, and the worktree path scopes counts and notices.

`data/reports` and the old `data/issues` are kept by `uninstall` exactly like the rest of `data`. Report writes go through a temp file and a rename; a new report is staged in `data/reports/.staging-<id>-<rand>/` and renamed to `<id>`, and reads ignore folders without `report.json` and `.staging-*` folders. Delivery states are `queued`, `uploading`, `creating`, `reconciling`, `retry_wait`, `failed` and `sent`.

`config.json`: `{ "v": 1, "port": 4387, "publicBase": "https://<machine>.<tailnet>.ts.net:4388" | null, "pcTailnetIps": [...], "owner": "<tailscale login>" | null, "baseline443": {...}, "mode": "trial" | "primary", "summary": { "enabled": true, "models": [...] }, "cacheLeadMinutes": 5, "progress": { "modelLines": true }, "episode": { "stallMinutes": 60 }, "reports": { "repo": "yjacket/omo-inbox", "label": "inbox-report", "assetsBranch": "inbox-report-assets", "folder": null } }`. `server.json` is written only by the server: `{ "v", "name", "port", "pid", "started", "version" }`. Install doesn't write it. `next.closeTab` (default true) lets a close also close the Orca tab; `false` leaves the tab open.

## HTTP API
Server on `127.0.0.1:4387`. All POSTs need `content-type: application/json` and `x-inbox: 1` (else 403). Body limit 30 MiB (else 413); `/api/reports*` instead reads at most 12 MiB, enforced while reading before JSON parsing. `/api/*` responses are `cache-control: no-store`; revision files are `public, max-age=31536000, immutable`.

| Method | Path | Access | Response |
| --- | --- | --- | --- |
| GET | `/` | read | threads list page |
| GET | `/s/<sid>`, `/boards` | read | thread page, proposal list page |
| GET | `/p/<id>` | read | proposal page |
| GET | `/web/<file>` | read | static file |
| GET | `/sw.js` | read | the service worker (`Service-Worker-Allowed: /`, `cache-control: no-cache`) |
| GET | `/files/<id>/revs/<n>/<path>`, `/files/<id>/crops/<file>` | read | file; traversal -> 403 |
| GET | `/api/health` | read | `{ ok, name: 'omo-inbox', version, pid, port }` |
| GET | `/api/caps` | read | `{ access, open, targets }` |
| GET | `/api/proposals?product=&feature=&status=` | read | `{ items, facets, counts }` (counts = unfiltered `{ mine, theirs, closed, reports }`; `reports` = open report boards) |
| GET | `/api/p/<id>?since=<seq>` | read | `{ proposal, summary, url, revs, events }` |
| POST | `/api/p/<id>/feedback` | feedback | `{ ok, seq, status, routed, delivery }`; verdict `change`, `approve` or `ack` (see Data layout) |
| GET | `/api/push/key` | read | `{ publicKey }` (VAPID, base64url) |
| POST | `/api/push/subscribe` | feedback | `{ ok }`, then a welcome push to that browser |
| POST | `/api/push/unsubscribe` | feedback | `{ ok }` |
| POST | `/api/open` | open | `{ ok, cmd }` |
| POST | `/api/proposals` | session | `{ summary, url, existing }` |
| POST | `/api/p/<id>/revise` | session | `{ summary, url }` |
| POST | `/api/p/<id>/reply` | session | `{ summary }` |
| POST | `/api/p/<id>/close` | session | `{ summary }` |
| GET | `/api/reports?limit=&cursor=` | read | `{items: [Row], counts: {pending, failed, sent}, nextCursor, repo, statesAt}` newest first; `limit` 1..100, default 50; `cursor` is a report id |
| GET | `/api/reports/<id>` | read | `Row` plus `delivery: {state, attempts, nextAttemptAt}`; 404 `not_found` |
| GET | `/api/reports/<id>/image` | read | the stored PNG, or 404; `Content-Type: image/png`, `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'`, `Cache-Control: private, no-store` |
| POST | `/api/reports` | feedback | 201 `{ok: true, id, state, github: null}`; exact replay 200 `{ok: true, id, state, github, replay: true}`; 400 `{error: "bad_input", fields}`; 409 `key_reused`; 403 `forbidden`; 413 `too_long` |
| POST | `/api/reports/<id>/retry` | feedback | failed -> queued, 200 `{ok: true, state: "pending"}`; 409 `not_failed`; 404 `not_found` |
| POST | `/api/reports/<id>/handoff` | reopen | `{ok: true, via, session}`; 409 `not_sent` or `cwd_missing`; 503 `no_launcher`; 502 `launch_failed`; 404 `not_found` |
| GET | `/api/here?cwd=&session=[&start=1][&idle=0\|1]` | session | `{ product, feature, mine, theirs, pending, waiting, notice, noticeKeys, footer }` |
| POST | `/api/bye` | session | `{session, closed?}` -> `{ ok }`; `closed: true` closes the thread's open items as `session-closed` |
| POST | `/api/shutdown` | session | `{ ok }`, then exit |
| POST | `/api/threads/<sid>/items` | session | `{kind, policy, dedupeKey, raw, meta}` -> `{item, created, summaryRequest\|null, summaryConfig}` |
| POST | `/api/items/<itemId>/summary` | session | `{text, model, simpler}` -> `{ok, summary}`; an invalid summary keeps the heuristic one and answers `{ok: false}` |
| POST | `/api/items/<itemId>/close` | session | `{reason, resolvedBy}` |
| POST | `/api/threads/<sid>/activity` | session | `{source, cause}`; `cause` `owner` (default) or `system` |
| POST | `/api/items/<itemId>/state` | session | `{state: "waiting"\|"resumed", reasons (<= 10, each <= 40 chars), boards (<= 5 `{id, title <= 80, url}` with an http(s) url)}` -> `{ok}`; anything else 400 |
| POST | `/api/threads/<sid>/cache` | session | `{warmUntil, ttlSec}` |
| POST | `/api/threads/<sid>/meta` | session | `{title?, ended?, sessionFile?, ...meta}` |
| POST | `/api/items/<itemId>/answer` | feedback | `{answers?, text?, comment?, choice?, feedbackText?}` -> `{ok, deliveryId}`; 409 `{error: "closed", reason}`; 400 `question_incomplete` / `invalid_answer` |
| POST | `/api/threads/<sid>/message` | feedback | `{text}`; a free message, on a new `turn` item when none is open |
| POST | `/api/items/<itemId>/explain` | feedback | `{ok}`; 409 when the session is not live |
| POST | `/api/items/<itemId>/delivered` | session | `{deliveryId, how, detail}`; how `control` acks a session-control file, `dropped` with detail `item closed` or `stale` |
| POST | `/api/threads/<sid>/read` | feedback | `{seq}` |
| POST | `/api/notices` | session | a v1 notice (see Notices for other extensions); 400 with `details` |
| GET | `/api/threads?status=` | read | `{items: rows, counts: {needsYou, working, ended, hidden}, reviews: {mine}}`; rows carry `live`, `off`, `hidden` and include hidden threads with `hidden: true` (so does `inbox threads --json`); `needsYou` leaves hidden threads out |
| POST | `/api/threads/<sid>/hide` | feedback | `{hidden: boolean}` -> `{ok, hidden}`; 400 `bad_input`; 404 `not_found` |
| POST | `/api/threads/<sid>/reopen` | reopen | `{}` -> `{ok, via: "orca"\|"wt"\|"sink", already?}`; 409 `{error: "live"\|"cwd_missing"\|"no_session"}`; 503 `no_launcher`; 502 `launch_failed`; 404 `not_found`; 400 for the `_notices` thread |
| POST | `/api/items/<itemId>/action` | reopen | `{action, confirm?}` -> `{ok, via: "message"\|"session"\|"offline"\|"orca"\|"wt"\|"sink", deliveryId?, off?, session?}`; 404 `not_found`; 400 `bad_input` (no such action id); 409 `{error: "closed", reason}`, `busy`, `off`, `confirm_required` `{warnings}`, `stale` `{next}`, `plan_missing`, `cwd_missing`; 503 `no_launcher`; 502 `launch_failed`; 403 `forbidden` |
| POST | `/api/threads/<sid>/actions` | session | `{producer, actions}` -> `{ok}`; 400 `bad_input` with `details` |
| GET | `/api/threads/<sid>?since=` | read | `{thread, items: [item + status + summary + answers], events}`; progress items come without `raw.text` |
| GET | `/api/threads/<sid>/episodes/<key>` | read | `{request, lines: [{id, at, text, headline}], final: {id, at, text} \| null}` in order; a last line equal to the final is not repeated |
| GET | `/api/items/<itemId>` | read | the item with its status and delivered deliveryIds |

Items and their views carry `next` (the contract shape, or null). 내 차례 rows and ended rows with an actionable closed final carry `next: {state, label}` or null. The thread view adds `handoff` (`{to, via, status, slug, at}` or null) and `actions` (the provider actions). `/api/here` takes `watch=<n>`, the session's live count of standing monitors.

Report create is `{v: 2, reportId, description, page, element, view, source, image}`: `reportId` a uuid v4, `description` 1..8192 UTF-8 bytes, `page` `{kind: "inbox"|"thread"|"boards"|"proposal"|"issues", route, url, title, frames}` (`url` a pathname, plus `?s=<sid>` only on `/`, at most 2048 bytes; `title` at most 160 bytes; at most one frame `{selector, url}`), `element` null or `{selector, selectorStability, domPath, domPathTruncated, tag, role, label, textExcerpt, excerptTruncated, rect}` (selector and DOM path at most 2048 bytes, label 160, excerpt 512), `view` `{layout, visual, scroll, dpr, colorScheme, pointer}`, `source` null or `{kind: "thread", threadId, itemId}` or `{kind: "proposal", proposalId, revision, frame}`, and `image` null or `{provenance: "snapshot"|"upload", png, width, height}` (base64 PNG, each side at most 4096, at most 2,097,152 px, at most 8 MiB decoded, its header must match the stated size). Unknown keys, a client-sent `source.product` included, are 400 with their JSON paths in `fields`. The server adds `source.product` from its own thread or proposal record and redacts credential patterns in the description, element label, excerpt and page title before storing. A replay with the same `reportId` and the same content returns the stored report; different content is `key_reused`.

`Row` is `{id, title, createdAt, state: "pending"|"failed"|"sent", detail, github: null|{number, url, state: "open"|"closed"|null, comments}, image, handoff: null|{at, via}}`. `detail` is the fixed Korean failure reason or null. Stored delivery states map to `failed`, `sent` and `pending` for everything else. GitHub open/closed state and comment counts come from a cache that is refreshed in the background, so the list never waits on GitHub; `statesAt` is the time of its last successful refresh, or null.

`waiting` lists the calling session's open decision boards that wait on the owner: status `mine`, or `theirs` while the latest feedback is still undelivered (delivery `pending`). Each entry is `{ id, title, url, status, since, seq }`, where `since` is the time of the board's last submitted, revised or feedback event (a session reply never moves it) and `seq` is the latest feedback's seq for `theirs`, else `null`. Report boards, ownerless boards and other sessions' boards are never listed, and without `session` it's `[]`.

`idle=1` tells the server the session is idle and `idle=0` that it's busy; the stall watchdog (see Notifications) counts only idle time. Reading `/api/here` without `start=1` has no effect beyond the liveness touch.

Dedupe: an item post whose `dedupeKey` starts with `line:`, `turn:` or `episode:` returns the existing item of any status with `created: false`. Other keys, notices included, match open items only.

Errors: `not_found` 404, `closed` 409, `duplicate` 409 `{ error, id, url }`, `bad_rev` / `bad_input` 400, `invalid_board` 400 with `details`, access denied 403 `{ error: 'forbidden' }`, `/api/open` URL over 30000 chars 413 `{ error: 'too_long' }`, `/api/open` with the Aside exe missing 404 `{ error: "not_installed" }`.

`/api/open` targets come from `web/targets.json` (ChatGPT, Claude, Claude app, Aside, copy). PC-only targets need `open` access. Aside gets the board URL with `--single-argument`; others go through `rundll32 url.dll,FileProtocolHandler`.

An answer to a question is checked against the question: a non-blank comment is `comment-submitted`; else at least one question must be answered (else 400 `question_incomplete`); labels must be exact option labels and a single-select question takes one (else 400 `invalid_answer`). An answer with no `delivered` after 60 s is reported with `deliveryUnconfirmed: true`.

If the port is already held by an omo-inbox server, `node src/server.mjs` exits 0 quietly; anything else is logged and exits 3.

## Access
Each request is classified as `local`, `pc`, `tailnet` or `reject`:

1. Remote address not loopback -> reject.
2. `tailscale-funnel-request` header present -> reject.
3. No `x-forwarded-for`: Host `127.0.0.1` or `localhost` -> local, else reject.
4. First XFF entry in `pcTailnetIps` -> pc (checked before identity, since tailscaled may omit identity headers for the machine's own traffic).
5. No `tailscale-user-login`, or a login other than `owner` -> reject; else tailnet.

| Access | Allowed |
| --- | --- |
| read, feedback | local, pc, tailnet |
| open | local, pc |
| reopen | local, pc, tailnet |
| session | local |

So a phone on your tailnet can read and send feedback, but can't submit, post items, close as a session, or launch programs on the PC, except `POST /api/threads/<sid>/reopen`, which resumes only that thread's stored session.

Report routes keep that ALLOW map unchanged: reading is `read`, create and retry are `feedback`, and handoff is `reopen`. For forwarded tailnet report requests the server additionally requires a configured non-null owner; local and known-PC requests keep their current classes. Browser mutations require an `Origin` header equal to the request's validated local origin or the configured `publicBase` origin. A missing `Origin` is allowed only for the local non-browser CLI and tests; `Origin: null`, foreign origins and Funnel are rejected. A handoff takes nothing from the request but the report id: the server picks the folder and the message.

## Session wake and capture
### Capture

The extension (`extension/omo-inbox.ts` with `extension/inbox/*.ts`) captures only in root interactive sessions. It never registers `before_agent_start`.

- Questions: `ask-user:asked` creates a `question` item; `ask-user:closed` closes it as `answered-phone`, `answered-terminal`, `timed-out` or `cancelled`.
- Permissions: a `Permission required:` select during a run creates a `permission` item.
- Episodes: an agent start with no open episode opens one. Every agent start while it is open extends it (job wakes, goal continuations, phone replies, answers, board feedback, terminal input); an owner-caused start only counts an interjection. After the final, the next start opens a new episode.
- Lines: each assistant message with text posts a `progress` line, dedupe `line:<sid>:m<message stamp>`, raw text up to 8192 characters.
- Will it wake: at a turn end the session will wake again when a question or dialog is open, a wake source other than `omo-inbox` counts, a monitor runs, a hold is active (its own `omo-inbox` hold counts), a continuation is scheduled (`goal_continuation_timer_state` `armed`), or it was restored within the last 60 s. Terminal background sessions and monitors count only when they started after the episode opened and are not persistent or paused. Wake counts are level state and survive turn ends and reloads.
- Close: a turn end that will wake adds only the line. Otherwise the episode closes, checked in this order: you aborted -> quiet `turn`; goal blocked in this run -> `blocked` (a goal that was already blocked before the run does not close later work); goal completed (or completed by `update_goal` in this episode) -> `done`; goal still active -> `turn` marked stalled; else -> `turn` that needs you. The final's dedupe key is `episode:<sid>:<opener stamp>:<close reason>:m<last stamp>` and its raw holds `{final, request, lastRequest, goal?}`.
- Flip: while idle with an episode open, a signal that turns waking off arms a 10 s timer; if it's still idle and nothing would wake it when the timer fires, the episode closes (stalled when a goal is active).
- Goals: `update_goal` blocked or complete inside an episode closes it at the turn end (pending close); outside an episode, or the goal file changing, creates `blocked` or `done` as before.
- Reopen: when a start opens an episode with no line yet and the session's newest episode item is a stalled final or a final not pushed yet, the server continues that episode under the same key instead of starting a new one.
- Owner causes: a phone delivery, a question answer and board feedback mark the next agent start as owner-caused, once, for up to 30 minutes; terminal input is owner-caused. Every other start is `system`.
- Restore: on every session start (startup, resume, reload) the extension reads the thread's newest item with `meta.episode` and continues an episode that has no final, counting as waking for a 60 s grace.
- Log: every verdict writes `capture: <verdict> <reasons>` to `extension.log`.
- A turn item's dedupe key is `turn:<sid>:m<send time of the last assistant reply>`, the same in every copy of the extension. A `/reload` inside the 2.5 s wait drops the old copy's classification; on a reload start the new copy reads the transcript, and when it ends on a finished assistant reply with no item in the thread after that reply, it classifies that reply once.
- Activity: terminal input and agent starts are posted with their `cause`, which closes stale turn items.
- Thread meta (cwd, session file, session name, first and last request, model) is sent on the first post and at session start.
- Prompt cache: every assistant message start moves the warm-until time from the model's cache lifetime; it is posted when it moves by more than 30 s.

### Answer delivery

- The question bridge wraps the session's question UI. A phone answer resolves the waiting question and closes the terminal overlay; a terminal answer wins if it comes first. After `/reload` the wait is gone, so the item says `리로드 후에는 터미널에서 답해 주세요`. A runtime without the hook leaves the item terminal-only (`터미널에서 답해 주세요`).
- A late phone answer to a closed question is dropped when another surface answered it, and otherwise sent once as `[omo-inbox] 폰에서 늦게 온 답 (질문 "<header>"): <answer>`.
- Permission answers map to `Allow once`, `Deny` and `Deny with feedback` (the feedback text answers the following feedback prompt). A closed dialog acks `refused`.
- Every 3 s, and after each status refresh, the extension drains `<home>/mailbox/<session>/`, records each delivery id in `<home>/ledger/` first, and acks `/api/items/<itemId>/delivered`. Replies to turns, blocked, done and notice items and free messages are admitted as follow-ups while the session is idle and as steers into the running turn while it is busy (`admitExternalMessage` with the current turn epoch, else `sendUserMessage`); a `turn_conflict` or held draft keeps the file for the next tick. Question answers never steer. A delivery id already in the ledger is re-acked with its recorded how before the file is deleted. `explain` reruns the summary in simpler words.
- Reopen. `POST /api/threads/<sid>/reopen` resumes a session that is off, from fixed launcher commands built on the PC out of thread.json. The target is the stored `sessionFile` when it is a safe path to an existing `.jsonl`, else the sid. The session folder must be a safe absolute path that exists. When `orca.exe worktree list --json` lists that folder, it opens an Orca terminal tab (`orca.exe terminal create --worktree path:<folder> --title <title> --command 'omo --session "<target>"' --focus --json`); otherwise, or when Orca exits with an error, a Windows Terminal window (`wt.exe -w -1 new-tab -d <folder> --title <title> <omo> --session <target>`). An Orca timeout or an unreadable reply stops there (`launch_failed`) instead of trying Windows Terminal, because Orca may already have opened the tab. Processes are spawned with an argument list, never a shell. A second reopen of the same session within 60 s opens nothing and answers `already: true`. The reply stays in the mailbox and is delivered once the session connects. `INBOX_REOPEN_SINK=<file>` writes each planned attempt as one JSON line instead of launching (tests and QA).

### Board wake

For visual boards the extension keeps omo-desk's behavior. It does nothing in child or task-member sessions. In a normal session:

- Every 3 s it reads `<home>/mailbox/<session>/*.json` board feedback. When the proposal is still `theirs` (or the server is unreachable) it delivers the text as a follow-up message that starts a turn, then deletes the file. An in-memory set prevents double delivery.
- Every 30 s, at session start and after each delivery it calls `/api/here`. The footer shows `🙋 {mine} 🤖 {theirs}`, leaving out a side whose count is 0. If the server is down it shows `Inbox 서버 꺼짐` and runs `inbox server start` at most once per 120 s.
- Notices: feedback waiting in this worktree whose owner isn't live (no `/api/here` call in 90 s, ended, child, or no id) is announced once per session. A resumed session is reminded of its own unanswered feedback at start.
- On shutdown it calls `/api/bye` so the owner counts as gone at once; when the shutdown reason is not `reload` it adds `closed: true`. A plain bye (`/reload`) keeps the session counted as live for 90 s, and the server keeps the last `/api/here` time per session in `<home>/data/live.json` and restores entries younger than 90 s at start. Since extensions touch `/api/here` every 30 s, a live thread never flickers to 끝남 or `세션 꺼짐`.
- Waiting boards: after every successful `/api/here` refresh it reports the `waiting` boards inside the answer window to senpi as wake source `omo-inbox` (`wake_source_state` `{ source: "omo-inbox", activeCount }`, emitted before the hold) and holds goal continuation (`continuation_hold_state` `{ source: "omo-inbox", active }`). Without this, a goal re-prompts at once and the agent mirrors the board with the question tool, which a board answer can't settle. senpi reads only `source`/`activeCount` and `active`.
- Release (hold false, then count 0) happens when no board is left, and at shutdown. While the server is unreachable, the last known waiting list is re-evaluated against the local clock on every tick: boards inside the window keep counting, expired ones release.
- The answer window is senpi's `askUser.timeoutMinutes` (default 30), clamped to 1-120 minutes. It's measured from `since`, the board's last submitted, revised or feedback event, never a session reply. Viewing the page doesn't restart it, unlike the question tool's idle timer. An unparsable `since` counts as expired. Boards with status `theirs` always count.
- It also refreshes after every tool execution (single-flight, with one rerun when a refresh was requested mid-flight), so a board submitted during a turn counts before the turn ends.
- No answer: when a `mine` board passes the window it stops counting and the session gets one follow-up message `[omo-inbox] 답이 없습니다: <title> (<id>), <n>분` that starts a turn, once per board and last-event time. After a session start or reload, a board that's already past the window gets no notice.
- While a board counts, senpi treats it as background work, so a Stop hook for that turn is deferred until the answer turn (the omo-inbox push notification is what tells the owner). While held, senpi shows no goal countdown; the footer `🙋 N` is the indicator. Child sessions and non-senpi sessions get neither the hold nor the notice.
- After `/reload` the replaced copy of the extension stops its timers the first time senpi reports its generation as stale, so only the current copy polls and wakes the session.

Session ids come from `INBOX_SESSION` or `PI_SESSION_ID`. The extension isn't changed by board kinds: it already delivers `theirs` boards, including a report acked with a comment.

Two paths differ. The inbox follow-up is automatic: it starts a turn in the owning session. The pending notice (`inbox pending`, `/api/here`) is passive: it only tells a session that feedback is waiting, so an ownerless board is seen but never delivered as a turn.

## Next actions
The server computes a verdict for every needs-you final (`turn`, `done`, `blocked`, stall finals included) when it arrives, when its model summary arrives, when a provider list changes, and on a thread open when the stored one is older than 30 s. At server start it backfills finals stored before this update. Progress items get none.

- Shape: `{v: 1, state, reason, actions, warnings, facts: {git, plan, watch}, source: "heuristic"|"model", at}`.
- Precedence: `blocked` (kind blocked) -> `stalled` (a stall final) -> `ask` (the final asks something that isn't a wrap-up or plan question) -> `plan` (an open plan was found) -> `ship` (dirty or unpushed git, a wrap-up marker in the text, a wrap-up ask, or a model `ship` hint) -> `done`.
- Reasons: done `남은 일이 없습니다`; plan `계획 <slug> 실행 대기`; ship `커밋 안 된 변경 N개 · 푸시 안 된 커밋 N개` (only the parts that apply) or `마무리 작업이 남았습니다`; ask `답을 기다립니다`; blocked `막힌 목표를 풀어야 합니다`; stalled `멈춘 작업을 이어가야 합니다`.
- Detectors read the last 1500 characters of the final (a plan slug the final does not name is also looked up in the last three lines of the same work span, since an agent often names the next step and then closes with a short report): a plan slug (`/skill:ulw-execute`, `/ulw-execute` or `$ulw-execute` followed by the slug), a nothing-left line (`Next: 없음`, `남은 작업 없음`, `할 일이 없습니다`), and wrap-up markers (not committed, not pushed, not installed, `/reload` needed).
- Git facts: `git status --porcelain=v1 --branch` in the worktree, else the cwd (`git -C <dir>`), no shell, 3 s timeout. A folder that isn't a repository gives `git: null`; any other failure or the timeout gives `{unknown: true}` with the warning `git 상태를 확인하지 못했습니다` and no git action.
- Plan detection: the slug from the final's tail is looked up as `.omo/plans/<slug>.md` in the worktree, then the cwd, then the main checkout; `root` is the folder holding `.omo/plans`. The plan is open when it still has an unchecked `- [ ]` row. A session that executes that plan itself (its `executes`, or the slug it was handed off with) never gets a plan offer.
- Model hint: a model summary may carry `next` (see Summaries); it's used only when the summary came from the model.
- Warnings, in order: `커밋 안 된 변경 N개`, `푸시 안 된 커밋 N개`, `상시 감시 N개가 함께 꺼집니다`, `git 상태를 확인하지 못했습니다`.
- Actions (at most 5, at most one primary, primary first):

| id | kind | label | prompt | when |
| --- | --- | --- | --- | --- |
| `close` | close | `세션 닫기` | - | every state; primary for done |
| `new-session` | new-session | `새 세션에서 실행` | `/skill:ulw-execute <slug>` | plan, primary |
| `commit-push` | continue | `커밋·푸시` | `변경을 커밋하고 푸시해` | ship with uncommitted changes, primary |
| `push` | continue | `푸시` | `커밋을 푸시해` | ship with only unpushed commits, primary |
| `m1`, `m2` | continue | model label (12 chars) | model prompt (200 chars) | done, ship |
| `p:<producer>:<key>` | continue or run | provider label | provider prompt | done, ship, ask, blocked, stalled; run only while live |

- A session that quit. The thread's newest needs-you final, closed as `session-closed` with no newer needs-you item and no handoff, is the actionable closed final. Its next is computed with close and run actions left out, so it offers only the plan and continue actions; continue is stored in the mailbox until the session is reopened.
- Tap-time re-check: before close, commit-push, push and new-session the server probes git and the plan again. A new-session whose plan file is gone answers `plan_missing`; any other action that disappeared answers `stale` with the fresh next; a close whose fresh warnings aren't empty needs `confirm: true`, else `confirm_required` with the warnings.
- Delivery: continue goes through the mailbox like a reply. Close and run on a live session write `<home>/control/<sid>/<deliveryId>.json` `{v: 1, type: "session-control", action, itemId, deliveryId, issuedAt, producer?, key?}`. The extension reads them after the mailbox, records the delivery id in the ledger, and acks `control`; a control whose item is closed acks `dropped` `item closed`, and one older than 10 minutes `dropped` `stale`. Close calls `ctx.shutdown()` and the bye closes the items as `closed-by-owner`. Close on an off session closes them at once. Run emits `inbox:action` (see Actions for other extensions).
- Standing monitors: the extension counts persistent, unpaused monitors on each final (`meta.watch`) and sends the live count on every `/api/here?watch=<n>`. Close warnings use the live count.
- Fresh session: new-session launches `omo --session-id <uuidv7> "/skill:ulw-execute <slug>"` in the plan root, in an Orca tab when Orca lists that folder, else in Windows Terminal, the same way as reopen. When the new session first calls `/api/here`, the handoff turns `connected` and the old session is closed as `handed-off` (a control file when live, at once when off).
- Orca tab: when the session runs in Orca (`ORCA_TERMINAL_HANDLE` set), close starts `bin/close-tab.mjs`, which waits for omo to exit and then runs `orca terminal close --tab`. `config.json` `next.closeTab: false` turns that off.
- Rollout: sessions started before this update don't read control files; run `/reload` in them before close works.

## Summaries
The server builds the summary request and checks the result; the extension only runs the model.

- Models: `config.json` `summary.models`, default `anthropic-subscription/claude-sonnet-5`, then `chatgpt-subscription/gpt-6-luna-fast`, then `anthropic-subscription/claude-haiku-4-5`. The first configured and authenticated one is used, with a 60 s timeout. When the first model has not answered within 30 s, the next one starts and the first usable answer wins. The session's own model is never used. `summary.enabled: false` keeps heuristic summaries only.
- Fallback: until a model summary arrives, or when the model fails or returns something invalid, the item shows a heuristic summary: the handoff block's `For you` line or the first line as headline, `요청: <first request>` as context, the text without paths and code as body, the last question sentence as the ask (or, without a question, the last sentence that gives you a to-do, such as `직접 실행해야 해요`), and a no-answer line from the item kind.
- Shape: headline up to 40 characters, context up to 120, body up to 300, ask up to 120, up to 4 options with reasons, a no-answer line, up to 3 explained terms, and a thread title (24 characters) when the thread has none. A recommendation appears only when the source has one; the prompt forbids inventing it.
- Ask and terms: `ask` holds the question to you or a to-do the source says you must do yourself (run, install, check, close a window, start a session); it's null only when there is neither. A term must appear word for word in the headline, context, body or ask; any other term is dropped. The wait label for a board is `Review 답` and the close label for needs-you is `내 차례`.
- Check and repair: before clipping, the server checks a model summary for code-like or English tokens outside the known terms, fields over their limit, a headline that only names a process step, a closing question the summary dropped, a closing to-do left out of an empty ask, and a question summary without the recommendation the source makes. If anything is found, it keeps the clipped draft and asks the extension for one repair pass with the issues listed; the repaired summary is stored without another check.
- No-answer line: the model never writes it. The server sets it from runtime facts: a required question waits (`답이 없으면 그 작업은 하지 않고 기다립니다`), an optional one proceeds on the agent's own judgment after the timeout, an answer-later question (`waitForAnswer: false`) says the agent keeps working, a permission prompt waits, a waiting turn says the session waits (or that the goal is stuck when it stalled), a blocked goal stays blocked, and reports, progress, notices and boards have none.
- Recommendation of a question-tool item: when an option is marked recommended (`권장`, `추천`, `Recommended`) and the summary does not name it, the server puts `권장: <option>` at the start of the body.
- `더 쉽게` asks for the same summary in simpler words.
- Lines: a progress line gets a heuristic headline at once (the handoff `Now:` slot, else the first sentence after a routing sentence, else the first line, up to 40 characters; English falls back to `대기: <label>` or `진행 중`), then a Korean model one-liner of 40 characters or fewer replaces it. `progress.modelLines: false` turns the model call off. Line requests never delay a needs-you summary, and only the newest 3 waiting lines get one.
- Next hint: for turn, done and blocked items the model may add `next: {state: "done"|"ship"|"ask", actions: [{label (12 chars), prompt (200 chars)}]}` or null; actions are only follow-ups the final names itself (install, reload, test server, deploy, check), at most 2.
- Episode finals: the request holds the span (`이번 작업 구간`: message count, times, close reason, questions, interjections), the opener request, each line's one-liner with its time (newest 30), and the final message (head 3000, tail 1500), 8000 characters at most. The final message's outcome is the conclusion; a waiting line is never a result. Stalled wording appears only for a real stall.
- Context: the session's folder is labeled `세션 폴더`, not the product; the summary names the product the episode actually worked on.
- Privacy: everything put into the request goes through `src/redact.mjs` first (tokens, keys and similar secrets are masked). Long text is cut to its first 4000 and last 2000 characters. Summaries stay on this PC.

## Notifications
Pushes follow the item kind and policy. A push is held for the hold time and cancelled when the item is closed or answered, or when activity arrived after it was created (you're at the terminal).

| Kind / policy | Push | Hold | Actions (max 2) |
| --- | --- | --- | --- |
| question, not required | yes | 15 s | `권장: <label>` when the question has a recommended option, then open |
| question, required | yes | 15 s | open |
| permission | yes | 15 s | open |
| turn | yes | 30 s | open |
| blocked | yes | 30 s | open |
| done | yes | 30 s | `세션 닫기` when the next is done without warnings, then open |
| progress | no | - | - |
| board (primary) | yes | 0 | open (new proposal, revise, reply) |
| notice now / soon | yes | 0 | open |
| notice fyi | no | - | - |
| cache reminder | yes | `config.json` `cacheLeadMinutes` (default 5) before the cache cools | open |

- Title `🙋 <thread title>`; body the headline plus the ask, redacted, up to 120 characters. Tapping opens `/s/<sid>#<itemId>`. Notifications of one thread replace each other (`tag: s-<sid>`).
- Cache reminder: `🔥 캐시가 <n>분 뒤 식습니다`, once per item and warm-until time, only while the thread has no active goal and the item is still open.
- After a server restart the schedule is rebuilt from open items; overdue holds fire at once for items under 60 minutes old.
- Episodes: lines never push. Only the final pushes, with the usual 30 s hold, so one request gives one push.
- Stall watchdog: an open episode whose session stays idle for `episode.stallMinutes` (default 60, clamped 5-240) after its last line gets one stalled final built from its lines, pushed; a session that's gone gets nothing. A busy report suspends it, and it is rebuilt after a server restart. `INBOX_EPISODE_STALL_MS` overrides it in milliseconds (tests).
- Only owner activity cancels a pending push; a system start (goal continuation, job wake) still supersedes items but never cancels a push.
- Hidden threads send no item or cache push. An item that arrives while the thread is hidden, or is still pending when it gets hidden, is marked handled (`pushedAt`) and never pushed later, not even after 숨김 해제 or a restart. Review notifications are unchanged.
- `INBOX_PUSH_SINK=<file>` appends each would-be push as a JSON line instead of sending it (tests and QA).

### Board notifications

The browser gets a notification when something arrives for you, even with the inbox closed. Tapping it opens that proposal (`/p/<id>`).

| Trigger | Title | Body |
| --- | --- | --- |
| New proposal (not an `existing` resubmit) | `새 Review · <title>` | `<product> · <branch>` |
| `inbox revise` | `수정본 <rev> · <title>` | the revise note, else `<product> · <branch>` |
| `inbox reply` | `답이 왔습니다 · <title>` | the reply text, cut to 120 chars |

Your own feedback and `inbox close` never notify. The push is sent after the HTTP response and never delays it; a failed send is logged to `logs/server.log`.

Turn it on from the inbox header, once per browser: `알림 받기` asks for permission, registers `/sw.js`, subscribes through the browser's push service and POSTs the subscription to `/api/push/subscribe` (so it works from the PC page and from the tailnet page; Funnel is rejected as everywhere else). The server answers with a welcome push whose body reads `새 Review와 답이 오면 알려 드립니다`. `알림 켜짐` turns it off again; `알림 막힘` means the browser blocked the permission. The button is hidden where the page is not a secure context (the tailnet `https` page and `127.0.0.1` are; a plain `http://<ip>` page is not) or the browser has no push support.

Stored in `<home>/push/`: `vapid.json` (the server's P-256 key pair, created on first use, written through a temp file and a rename) and `subscriptions.json` (one entry per endpoint: `endpoint`, `keys`, `created`, `ua`, `via`). Both are secrets; they stay on this PC. A send is a POST to the subscription's endpoint with `TTL: 86400`, `Urgency: high`, a VAPID `Authorization` header (ES256 JWT, 12 h) and an RFC 8291 `aes128gcm` body. 201/202 is delivered; 404/410 removes the subscription; anything else is logged and the subscription is kept.

Limits:

- The payload (title, body, `/p/<id>`) is end-to-end encrypted to the browser, so the push service (Google, Mozilla, Apple) only sees that something was sent.
- The PC must be on and the server running; nothing is queued for a server that is down.
- Android (Samsung Internet): it arrives with the tab and the browser closed, unless the browser app was force-stopped or is battery-restricted.
- PC: the browser program must be running (a background process is enough; the tab can be closed).
- Each browser and each origin (`http://127.0.0.1:4387` on the PC, the tailnet `https` origin on the phone) subscribes separately.

### Report notifications

When a report fails to reach GitHub, one push goes through the existing subscriptions: title `제보를 GitHub에 올리지 못했습니다`, body the report title clipped to 80 characters, URL `/issues`, tag `report:<id>`. It's sent once per failure, carries no description or picture, and a push failure changes nothing about the report. Nothing else about reports sends a push.

## Notices for other extensions
Other extensions can post to the inbox by emitting `inbox:notice` on `pi.events`; the extension fills in the session and cwd and forwards it to `POST /api/notices`. From a shell, `inbox notify` does the same.

Shape (v1): `{v: 1, producer, dedupeKey, title, body?, urgency, session?, cwd?, expiresAt?, url?, actions?}`.

- `producer` matches `^[a-z0-9-]{1,40}$`, `dedupeKey` matches `^[A-Za-z0-9._:-]{1,80}$`, `title` 1 to 80 characters, `body` up to 500.
- `urgency` is `now`, `soon` (push, needs you) or `fyi` (no push).
- `expiresAt` is ISO; an expired notice reads as closed `expired`. `url` is relative or https. `actions` is a subset of `["ack", "open-url"]`.
- A new notice with the same producer and dedupe key closes the previous open one as `superseded`. Notices without a session go to the `알림` thread.
- Errors are 400 with one `details` line per problem.

Example, a keepalive extension warning that the cache is cooling:

```ts
pi.events.emit("inbox:notice", {
	v: 1,
	producer: "omo-keepalive",
	dedupeKey: "cache-cooling",
	title: "캐시가 곧 식습니다",
	body: "5분 안에 이어 가지 않으면 다음 요청이 느려집니다",
	urgency: "soon",
});
```

```powershell
node "<home>/app/bin/inbox.mjs" notify --producer omo-keepalive --key cache-cooling --title "캐시가 곧 식습니다" --urgency soon
```

## Actions for other extensions
Other extensions can add buttons to a session's finals by emitting `inbox:actions` on `pi.events`; the extension validates the list and posts it to `POST /api/threads/<sid>/actions`, and resends it after a reconnect.

Shape (v1): `{v: 1, producer, actions: [{key, label, prompt?, run?}]}`.

- `producer` matches `^[a-z0-9-]{1,40}$`; 0 to 4 actions; `key` matches `^[A-Za-z0-9._:-]{1,40}$`; `label` 1 to 12 characters; exactly one of `prompt` (1 to 300 characters) or `run: true`.
- The latest list per producer wins; an empty list removes the producer. Actions show as `p:<producer>:<key>` after the built-in ones.
- A `prompt` action is sent to the session like a reply. A `run` action shows only while the session is live; a tap writes a control file and the extension emits `inbox:action` `{v: 1, producer, key, itemId, session}` in that session.

Example, a preview extension offering to open a preview:

```ts
pi.events.emit("inbox:actions", {
	v: 1,
	producer: "omo-preview",
	actions: [{ key: "open", label: "미리보기 열기", run: true }],
});

pi.events.on("inbox:action", (event) => {
	if (event.producer !== "omo-preview" || event.key !== "open") return;
	openPreview();
});
```

## Tailnet
- Port 4388 only: `tailscale serve --bg --https=4388 http://127.0.0.1:4387`.
- Never Funnel. Funnel requests are rejected by the server too.
- 443 is untouched. Install snapshots `serve status --json` first, and after adding 4388 it checks that the 443 Web entry, AllowFunnel and TCP 443 are unchanged. Any difference turns 4388 off again and reports `failed:443-guard`. The baseline is saved as `baseline443` for `doctor`.
- Public URLs look like `https://<machine>.<tailnet>.ts.net:4388/p/<id>`.
- The Orca mobile app reads a tapped link from the tapped screen row only, so a wrapped URL loses its tail (`:4388/...`). It opens whole only as a terminal hyperlink: set `"terminal": { "hyperlinks": true }` in `~/.omo/agent/settings.json` (senpi leaves hyperlinks off for Orca on Windows), and print the URL bare, not in backticks.

## Tests
```
node --test "test/**/*.test.mjs"
```

Tests use temp homes, port 0, fake runners for `reg`, `tailscale` and `wscript`, and short poll intervals. None of them wait on wall-clock time or touch the real home, agent dir or tailscale.

Browser QA for the proposal page (needs Bun 1.4+ and Chrome; not part of `node --test`): `bun qa/send-qa.mjs`, `bun qa/viewer-qa.mjs`, `bun qa/read-aloud-qa.mjs`. Each starts `src/server.mjs` on a temp home (ports 4391, 4392, 4393), drives headless Chrome at phone and desktop widths, ends with `N/N checks passed`, and leaves its screenshots in the temp dir it prints.

Browser QA for the Inbox turn flow: `bun qa/turn-list-qa.mjs` (port 4395), `bun qa/turn-thread-qa.mjs` (4396) and `bun qa/turn-bubble-qa.mjs` (4397), the same way. `bun qa/reopen-launch-qa.mjs` drives the real launchers: it opens and closes a real Orca terminal and a Windows Terminal window.

Browser QA for next actions: `bun qa/next-qa.mjs` (port 4402), the same way. `bun qa/session-qa.mjs` S25 and S26 cover close and new-session against a real session, and `reopen-launch-qa` also checks that a close shuts the Orca tab.

Browser QA for reports: `bun qa/report-pick-qa.mjs` (port 4403), `bun qa/report-send-qa.mjs` (4404) and `bun qa/report-look-qa.mjs` (4405), the same way. They point `INBOX_GITHUB_API` at a fake GitHub and never call the real GitHub API.

Every push in tests and QA goes to an `INBOX_PUSH_SINK` file, and every reopen to an `INBOX_REOPEN_SINK` file (except `reopen-launch-qa`). QA never uses ports 4387 or 4388.

## Development
- Work in a git worktree on a branch and open a PR against `main`. Direct pushes, force pushes and branch deletion on `main` are blocked; a PR merges only when its `test` check passes (`.github/workflows/test.yml`, windows-latest, `npm test`).
- Run the same tests locally with `npm test` (= `node --test "test/**/*.test.mjs"`).
- Live tests never touch the real setup: no real `~/.omo`, no server on port 4387, no HKCU Run value. Point `HOME`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `OMO_INBOX_HOME` and `INBOX_AGENT_DIR` at a temp folder, set `INBOX_NO_TAILSCALE=1` and `INBOX_RUN_VALUE` to a test name, and give the temp `config.json` another `port`.
- Don't commit tokens, real tailnet host names or `.omo/` scratch (evidence, screenshots, boards).

## Limits
- Windows only for install, autostart and launching.
- Proposals submitted before a repo gets a remote keep the `local/<name>` product key.
- The phone tap inside the Orca mobile app is not machine-verified.
- Viewer pinch and pan are checked with emulated touch in Chromium, not on a real phone. The comment sheet staying above the on-screen keyboard is not machine-checked.
- `듣기` uses the browser's speech synthesis, so it can stop when the browser goes to the background or the screen turns off.
- Windows Terminal tabs stay open after a close; only Orca tabs are closed.
- Sessions started before the next-actions update need `/reload` before close works.
- Single user: the tailnet owner check assumes one login.
- `/api/open` URLs are capped at 30000 chars (Windows command-line limit); longer content is copied instead.
- iOS shows no notification action buttons; tap the notification and answer on the page.
- A runtime without the question bridge degrades to `터미널에서 답하세요`: the item shows, but you answer in the terminal.
- Boards created while inbox is primary stay in inbox after handback.
- A stalled-episode final counts as still asking, so a stalled thread stays in 내 차례 after its session goes off.
- 듣기 in the thread page needs a tap; nothing is read aloud by itself.
- Reopen needs Orca or Windows Terminal (and `omo` on PATH for Windows Terminal) on the PC.
- Summaries need a subscription model; without one every item uses the heuristic summary.
- The report picture is a redraw of the chosen element, not a screen capture, so it can differ from what the screen showed.
- Android can't capture the screen in a browser; `사진 추가` is the way to attach a real screenshot.
- Only private destination repos are accepted.
- GitHub shows the inline picture only to viewers with access to the repo.
