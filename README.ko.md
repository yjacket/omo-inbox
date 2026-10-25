# omo-inbox

[English](README.md) | 한국어

omo 에이전트 세션이 나에게 바라는 모든 것을 휴대폰 Inbox 하나로 모읍니다. 세션 하나가 대화 하나입니다. 질문, 권한 요청, 끝난 턴, 막힌 goal, 시각 보드가 짧은 한국어 요약으로 들어오고, PC나 휴대폰에서 답하면 그 답이 물어본 세션으로 돌아갑니다. Node 24, 순수 ESM, npm 의존성 없음, 빌드 없음.

## 하는 일
루트 대화형 세션(`ctx.mode === "tui"`)마다 대화가 하나 생깁니다. print, json, rpc 실행과 하위 세션은 아무것도 모으지 않습니다. 대화에 들어오는 것:

| 종류 | 어디서 오나 | 할 수 있는 것 |
| --- | --- | --- |
| `question` | 질문 도구(`ask-user:asked`) | 선택지 고르기, 직접 쓰기, 의견 |
| `permission` | `Permission required:` 대화 상자 | 한 번 허용, 거부, 의견 달아 거부 |
| `turn` | 끝나고 내 답을 기다리는 턴 | 답장, 또는 계속해 / 승인 / 진행 / 멈춰; 또는 다음 행동(다음 행동 참고) |
| `blocked` | 막힘으로 표시된 goal | 답장; 또는 다음 행동 |
| `done` | 완료로 표시된 goal | 답장; 또는 다음 행동 |
| `progress` | 작업 구간(에피소드, 수집 참고)이 열린 동안 글이 있는 어시스턴트 메시지마다 | 읽기. 메시지마다 회색 한 줄, 푸시하지 않고 안 읽음으로 세지 않음 |
| `board` | 이 inbox의 시각 보드(아래 기획안 흐름) | 열기 |
| `notice` | 다른 확장의 `inbox:notice` 나 `inbox notify` | 읽기, 열기 |

- 에이전트 실행이 시작되거나 터미널에 입력하면 대화가 넘어갑니다. 열린 `turn`, `blocked`, `done`, `progress`, `board` 항목은 `superseded`(`다음 작업으로 넘어감`)로 닫힙니다. 질문과 권한 요청은 답하거나 시간이 지나거나 취소될 때만 닫힙니다. 진행 줄은 상태와 상관없이 대화에 남습니다.
- 요청 하나가 에피소드 하나입니다. 어시스턴트 메시지마다 회색 한 줄이 생기고, 일이 정말 멈출 때 마지막 메시지(`turn`, `blocked`, `done`) 하나가 옵니다. 백그라운드 작업이나 보드를 기다리는 동안은 내 차례가 아니라 한 줄입니다. trial 모드에는 조용한 `board` 항목이 없고, 세션이 기다리는 desk 보드는 가장 최근 줄에 나옵니다.
- omo를 종료하거나 다른 세션으로 바꾸면(`/reload` 는 제외) 그 대화의 열린 항목이 모두 `session-closed`(`세션 닫힘`)로 닫힙니다. 대화는 끝남으로 가고 🙋, 푸시, 캐시 알림에서 빠집니다. 그 대화에 보낸 답장은 우편함에 남았다가 그 세션을 다시 열 때 전달됩니다.
- 열린 질문에 폰으로 답하면 기다리는 질문 도구에 바로 들어갑니다. 터미널에서 먼저 답했다면 폰 답은 버리고 터미널 답을 보여 줍니다. 더는 기다리지 않는 질문에는 폰 답을 후속 메시지 하나로 보냅니다.
- 항목마다 세션을 지켜보지 않은 사람을 위한 요약이 붙습니다. 제목, 세션이 하던 일, 묻는 것, 원문에 있을 때만 권장안, 답이 없으면 어떻게 되는지(요약 참고).
- 시각 보드는 omo-desk와 똑같습니다. `inbox submit <boardDir>` 는 보드 폴더를 검사해 영구 기록으로 남기고 URL을 출력합니다. 기획안 페이지에서 그림에 표시하고, 질문에 답하고, 의견을 쓰고, 수정안을 요청(`재요청`)하거나 승인(`승인`)합니다. 세션은 `inbox reply`, `inbox revise`, `inbox close` 로 답합니다.
- 보드라는 개념은 사용자에게 **Review** 로 보입니다. Inbox 버튼, Review 목록, 종류 칩, 링크 줄, 기다림 라벨, 오류 문구, 푸시가 모두 Review라고 씁니다. 식별자 이름은 그대로입니다(`board.json`, `visual-board`, `/p/<id>`, `/boards`, `/api/proposals`, CLI 명령, 항목 종류 `board`).
- 누구 차례인가. 열린 needs-you 항목이 있고 세션이 살아 있으면 대화는 내 차례입니다. 세션이 꺼져 있으면 아직 묻는 것이 있을 때만 회색 `세션 꺼짐` 칩을 달고 내 차례에 남습니다. 묻는 것은 열린 question, permission, blocked, notice, board 항목, 요약의 `ask` 가 비어 있지 않거나 모델 요약의 제목이나 본문이 아직 묻거나 내가 할 일을 말하는 turn이나 done 항목(`ask` 가 할 일을 담기 전의 요약), 모델 요약이 없고 마지막 원문이 물음이나 할 일로 끝나는 turn이나 done 항목, 멈춘 에피소드의 마지막 메시지입니다. 그 밖에는 끝남으로 갑니다. 항목은 열린 채로 남으니, 세션이 다시 붙으면 대화는 저절로 내 차례로 돌아옵니다.
- 다음 행동. 마지막 메시지(`turn`, `blocked`, `done`)마다 남은 일을 판정합니다: `done`(남은 일 없음), `plan`(실행할 계획이 기다림), `ship`(커밋이나 푸시가 안 된 작업, 또는 마무리), `ask`(나에게 물음), `blocked`, `stalled`. 대화 페이지는 이것을 버튼으로 보여 줍니다: `세션 닫기`, `새 세션에서 실행`, `커밋·푸시`, `푸시`, 모델 제안 최대 2개, 다른 확장이 등록한 행동. 다음 행동 절 참고.
- Tailscale에서는 같은 페이지가 `https://<machine>.<tailnet>.ts.net:4388` 로 제공됩니다.

## 설치
주된 설치 방법은 omo 패키지입니다. 저장소가 비공개라 git이 접근할 수 있어야 합니다:

```powershell
omo install git:github.com/yjacket/omo-inbox
```

첫 omo 세션이 1분쯤 안에 스스로 설치합니다. 확장이 잠금(`<home>/setup.lock`) 아래 백그라운드에서 `inbox install --from-package` 를 실행합니다. 설치는 clone을 `<home>/app` 으로 복사하고, `<home>/app/source.json`(channel `package`, source, sha, version), 실행기, Run 자동 시작 값, 스킬 사본, 규칙, tailscale 4388 serve 핸들러(443 보호 장치 포함)를 쓴 뒤 서버를 시작합니다. 세션이 몇 개 시작하든 설치는 하나만 돕니다. 실패한 설치는 10분 뒤 다시 시도합니다. 상태는 `<home>/setup-state.json` 에 있고, 실행마다 `<home>/logs/install.log` 에 한 줄을 남깁니다.

업데이트는 `omo update --extensions` 입니다. 1분쯤 안에 다음 세션 주기가 앱을 바꾸고 서버를 다시 시작하며, 쉬고 있는 세션은 새 확장으로 reload 합니다.

제거는 두 단계입니다. 먼저 `/inbox uninstall`: 서버, 자동 시작, 실행기, 앱, 스킬, 규칙, 4388 핸들러를 지우고, `<home>/data` 는 남기며, 패키지가 움직이지 않도록 `<home>/disabled` 를 씁니다. 이 파일이 있는 동안 세션은 상태줄을 띄우지 않고, 설치나 서버 시작도 하지 않습니다. 그다음 `omo remove git:github.com/yjacket/omo-inbox`. `/inbox install` 은 꺼진 패키지를 다시 켭니다. `/inbox uninstall` 없이 패키지를 지우면 서버가 clone이 사라진 것을 알아채고 20분 뒤 스스로 제거합니다(`INBOX_ORPHAN_GRACE_MS`).

이전. 예전에 `install.ps1` 이나 `inbox install` 로 한 설치는 패키지가 넘겨받습니다. 예전 `<agentDir>/extensions/omo-inbox.ts` 사본이 있는 동안 패키지 확장은 설치만 실행합니다. 설치가 예전 사본을 지우면 세션이 reload 합니다.

개발자 설치. checkout 에서 `inbox install`(또는 `install.ps1`)도 그대로 되며 `source.json` 에 channel `checkout` 을 기록합니다. 패키지는 이것을 덮어쓰지 않습니다. 패키지로 넘기려면 `inbox uninstall` 을 실행합니다.

Windows PowerShell 한 줄로 checkout 없이 GitHub `main` 에서 개발자 설치를 합니다. `gh` 로그인(`gh auth login`)이 필요하고, Node 24 이상이어야 합니다:

```powershell
irm https://raw.githubusercontent.com/yjacket/omo-inbox/main/install.ps1 -Headers @{ Authorization = "token $(gh auth token)" } | iex
```

이렇게 파이프로 실행하면 `install.ps1` 은 `main` 을 임시 폴더에 받아 아래와 같은 `inbox install` 을 실행한 뒤 폴더를 지웁니다. Node가 24보다 낮거나 GitHub 토큰이 없으면 한 줄로 알리고 멈춥니다. 아래 옵션은 checkout 에서 실행할 때만 쓸 수 있습니다.

checkout 에서:

```powershell
.\install.ps1                 # = node bin\inbox.mjs install
.\install.ps1 --no-tailscale  # tailscale serve 생략
.\install.ps1 --no-autostart  # HKCU Run 값 생략
```

설치는 현재 폴더가 아니라 CLI가 들어 있는 체크아웃에서 복사합니다. 설치 사본(`<home>/app`)에서 실행하면 아무것도 멈추기 전에 거부합니다.

단계는 순서대로 실행되며 각각 `written | unchanged | skipped | failed:<reason>` 를 보고합니다.

| # | 단계 | 동작 |
| --- | --- | --- |
| 0 | `stop` | `/api/health` 가 응답하면 `/api/shutdown` 을 보내고 health가 실패할 때까지 기다림(최대 5초). |
| 1 | `app` | `<home>/app` 을 지우고 `bin src web extension skill rules package.json` 을 복사. |
| 2 | `launcher` | `<home>/launch-hidden.vbs` 작성. node를 `--max-semi-space-size=1 --max-old-space-size=128` 로 `<home>\app\src\server.mjs` 에 대해 숨김 실행. |
| 3 | `autostart` | `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` 값 `omo-inbox` = `wscript.exe "<home>\launch-hidden.vbs"`. |
| 4 | `extension` | `<agentDir>/extensions/omo-inbox.ts` 로 복사. 패키지 설치는 대신 그 예전 사본을 지움(`legacy removed\|absent`). |
| 4b | `mode` | `trial` 또는 `primary` 를 고르고(모드 참고) `mode: <mode>` 출력. |
| 5 | `skill` | `~/.agents/skills/visual-board/` 와 `~/.claude/skills/visual-board/` 를 `<app>/skill/` 로 교체. trial이면 건너뜀. |
| 6 | `rule` | `rules/visual-board.md` 를 `~/.claude/rules/visual-board.md` 로 복사. trial이면 건너뜀. |
| 7 | `config` | `tailscale status --json` 에서 `publicBase`, `pcTailnetIps`, `owner` 를 읽음. tailscale이 없거나 Running이 아니면 `null`, `[]`, `null`. |
| 8 | `tailscale` | 443 보호 장치와 함께 4388 serve 핸들러 추가(Tailnet 참고). |
| 9 | `server` | `launchServer()` 로 시작하고 `/api/health` 를 기다림(최대 10초). |

패키지 설치가 `<home>/app` 에 같은 sha가 이미 있으면 아무것도 하지 않고 `app: current` 를 출력합니다. 서버가 꺼져 있으면 확장이 시작합니다.

마지막 줄은 `열린 omo 세션에서 /reload 하면 확장이 반영됩니다.` 입니다.

`<home>` 은 `OMO_INBOX_HOME` 또는 `~/.omo-inbox`. `<agentDir>` 은 `INBOX_AGENT_DIR`, `OMO_CODING_AGENT_DIR`, `SENPI_CODING_AGENT_DIR`, `PI_CODING_AGENT_DIR` 또는 `~/.omo/agent`.

`inbox uninstall` 은 서버를 끄고, Run 값을 지우고, 확장, 스킬 폴더 두 개, 규칙을 지우고, 같은 보호 장치로 4388 핸들러를 끄고, `<home>/app`, 실행기, `config.json`, `server.json` 을 지웁니다. `<home>/data` 는 남기고 `data kept: <path>` 를 출력합니다. 지운 앱이 패키지 설치였으면 `<home>/disabled` 도 씁니다.

테스트와 격리 환경용 덮어쓰기: `INBOX_USER_HOME`(사용자 home, 기본 `os.homedir()`), `INBOX_RUN_VALUE`(Run 값 이름, 기본 `omo-inbox`), `INBOX_NO_TAILSCALE=1`(install, uninstall, doctor가 tailscale 호출을 모두 건너뜀), `INBOX_AGENT_DIR`(`<agentDir>` 로 가장 먼저 확인), `INBOX_ORPHAN_GRACE_MS`(주인 없는 서버의 자동 제거 지연, 기본 20분).

`inbox uninstall` 과 `/inbox uninstall` 은 omo-desk를 건드리지 않습니다.

`inbox doctor` 는 health, Run 값, 실행기, 앱 사본과 같은 확장(패키지 설치면 clone의 `extension/omo-inbox.ts` 가 앱 사본과 같고 예전 `<agentDir>/extensions/omo-inbox.ts` 가 없어야 함), 스킬과 규칙 존재, 4388 핸들러 존재, AllowFunnel에 4388 키 없음, 현재 443 Web 항목과 AllowFunnel이 `config.baseline443` 과 같은지 확인합니다. `<check>: ok|fail <detail>` 을 출력하고 모두 ok일 때만 0으로 끝납니다.

### 모드, 넘겨받기, 돌려주기

`config.json` 에 `"mode": "trial" | "primary"` 가 있습니다. `inbox mode` 가 출력합니다.

- 설치는 동작 중인 omo-desk가 없으면(`<deskHome>/app/bin/desk.mjs` 가 없거나 `<deskHome>/disabled` 가 있으면) `primary`, 있으면 `trial` 을 고릅니다. `<deskHome>` 은 `INBOX_DESK_HOME` 또는 `~/.omo-desk`.
- trial은 omo-desk 옆에서 돕니다. 설치는 `skill: skipped (trial)`, `rule: skipped (trial)` 을 출력하고 둘 다 쓰지 않으므로 에이전트는 보드에 계속 desk를 씁니다. desk가 보드를 붙잡고 있는 동안 끝난 턴은 조용한 `board` 항목이 됩니다. desk가 이미 푸시하기 때문입니다.
- primary는 스킬과 규칙을 씁니다. `inbox doctor` 는 primary에서만 이 둘과 `<home>/takeover.json`(또는 desk 미설치)을 확인합니다.

`inbox takeover` 는 desk에서 inbox로 넘겨받습니다. trial 모드이고 desk가 동작 중이어야 하며, 아니면 `takeover: skipped (<reason>)` 를 출력합니다. 단계마다 `<step>: <result>` 한 줄:

1. 시각과 desk의 `source.json` 을 담아 `<home>/takeover.json` 을 씁니다.
2. `<home>/data/proposals/` 에 없는 desk 기획안과 desk 우편함 파일을 `<home>/mailbox/` 로 복사합니다(`import: <n> proposals, <m> mailbox files`). 옮기지 않으므로 desk 데이터는 그대로 남습니다.
3. `desk uninstall` 을 실행합니다. 실패하면 `takeover: failed (desk uninstall)` 로 멈추고, 복사한 것은 해가 없습니다.
4. `<deskHome>/disabled` 와, inbox CLI를 실행하는 shim `<deskHome>/app/bin/desk.mjs`(표시 `SHIM.json` `{by: "omo-inbox"}`)를 씁니다. 그래서 예전 `desk` 명령도 계속 됩니다.
5. 모드를 primary로 바꾸고 스킬과 규칙을 설치합니다.

`inbox handback` 은 이것을 되돌립니다. `takeover.json` 과 primary 모드가 필요합니다. `SHIM.json` 이 omo-inbox를 가리킬 때만 `<deskHome>/app` 을 지우고, 스킬과 규칙은 inbox 사본과 바이트까지 같을 때만 지우며(아니면 `kept (modified)`), `<deskHome>/disabled` 를 지우고, 기록된 출처로 desk를 다시 설치하고(패키지: `install --from-package`, checkout: `install`, 모름: `desk: manual (/desk install)`), 모드를 trial로 바꾸고 `takeover.json` 을 `takeover-<epochMs>.json` 으로 이름을 바꿉니다. inbox가 primary일 때 만든 보드는 inbox에 남고 되돌려 복사하지 않습니다.

## 사용법 (CLI 표)
`inbox` 는 PATH에 없습니다. 에이전트는 `node "<home>/app/bin/inbox.mjs" <command>` 로 실행하며, 서버와 CLI는 안내문에 이 접두어를 그대로 넣습니다. `--json` 은 사람용 줄 대신 응답 JSON을 그대로 출력합니다.

| 명령 | 출력 | 종료 코드 |
| --- | --- | --- |
| `submit <boardDir> [--title t] [--note n] [--new] [--session id] [--session-file path]` | `id: <id>`, `url: <url>`, `owner: <id>` 또는 `owner: none` (서버가 `existing` 을 주면 `note: already submitted` 추가) | 0; 1 사용법 오류; 2 잘못된 보드(오류는 stderr); 3 서버 연결 불가; 8 내용이 다른 열린 기획안 중복 |
| `revise <id> <boardDir> [--note n] [--session id] [--session-file path]` | `id: <id>` `rev: <n>` `url: <url>` `owner: <id>` 또는 `owner: none` | 0; 1; 2; 3; 4 없음; 5 닫힘 |
| `reply <id> <text...>` (또는 `--file <path>`, `-` = stdin) `[--session id] [--session-file path]` | `ok <id> <status>` | 0; 1; 3; 4; 5 |
| `close <id> <summary...> [--session id] [--session-file path]` | `ok <id> closed`, 이어서 마지막 의견이 승인이면 `record: VISUAL-APPROVED <YYYY-MM-DD> <id> <url>`, 아니면 `record: VISUAL-CLOSED <YYYY-MM-DD> <id> <url>` | 0; 1; 3; 4; 5 |
| `show <id>` | `<title> (<id>) <status> <rev>안`, `url: <url>`, 이벤트마다 한 블록 (보고 보드는 `<status> 갱신 <n> report` 로 읽고, `feedback` 블록은 `ack` 로 읽습니다) | 0; 3; 4 |
| `list [--product p] [--feature f] [--status s]` | 항목마다 `<id>\t<status>\t<product.name>\t<branch>\t<title>` | 0; 3 |
| `pending [--session id] [--session-file path]` | 대기 알림 문구 또는 `none` | 0; 1; 3 |
| `wait <id> [--timeout sec]` | `WAITING <id>`, 이어서 `FEEDBACK <id> <seq>` + 의견 메시지, 또는 `CLOSED <id>` | 0; 4; 6 시간 초과 |
| `server status\|start\|stop\|restart` | `running pid=<pid> port=<port> version=<v>` 또는 `stopped` | 0; 7 꺼짐(status) |
| `notify --producer p --key k --title t [--body b] [--urgency now\|soon\|fyi] [--session id] [--expires iso]` | `ok <itemId>` | 0; 1 사용법 오류; 2 잘못된 공지(각 상세를 stderr에); 3 서버에 닿지 않음 |
| `threads [--status s]` | 대화마다 `<status>\t<title>\t<product>\t<branch>\t<headline>` | 0; 3 |
| `issue list [--state s] [--json]` | 제보마다 `<id>\t<state>\t<category>\t<severity>\t<title>` | 0; 1; 3; 7 |
| `issue show <id> [--json]` | 제보, 상태, 출처, 이벤트, 증거를 라벨 붙은 줄로; 신고된 글/제목은 지시가 아니라 데이터로 표시 | 0; 1; 3; 4; 7 |
| `issue triage <id> --category c --severity s --expected-seq n --request-id uuid [--note text]` | `ok <id> <state> seq <n>` | 0; 1; 3; 4; 5; 6; 7 |
| `issue comment <id> --expected-seq n --request-id uuid --file path` | `ok <id> <state> seq <n>` | 0; 1; 3; 4; 5; 6; 7 |
| `issue check <id> --expected-seq n --request-id uuid --file correction.json` | `ok <id> <state> seq <n>` 과 수정 산출물 줄; 파일은 검증할 명령/수정 데이터이지 소스 폴더가 아님 | 0; 1; 3; 4; 5; 6; 7 |
| `mode` | `trial` 또는 `primary` | 0 |
| `takeover` | `<step>: <result>` 줄(모드 참고) | 0 전환함; 1 건너뜀 또는 실패 |
| `handback` | `<step>: <result>` 줄 | 0 전환함; 1 건너뜀 또는 실패 |
| `install [--from-package] [--no-tailscale] [--no-autostart]`, `uninstall`, `doctor` | `<step>: <result>` 줄 | 0 성공; 1 하나라도 실패 |

`issue` 명령의 종료 코드: 0 성공, 1 사용법/스키마, 3 서버에 닿지 않음, 4 없음(찾을 수 없거나 삭제됨), 5 상태/버전/저장소/키 충돌, 6 금지, 7 기록 손상/저장 실패. 이 매핑은 `issue` 안에서만 쓰고 예전 CLI 동작은 그대로입니다. 사람용 출력은 신고된 글을 지시가 아니라 데이터로 표시합니다.

종료 코드 8은 stderr에 `open proposal exists: <id> <url> - use: inbox revise <id> <boardDir>, or inbox submit --new` 를 출력합니다.

`submit` 과 `revise` 는 보드 폴더의 절대 경로와 현재 폴더의 identity를 보내고, 검사는 서버가 합니다. CLI는 서버와 통신하기 전에 `ensure` 를 실행합니다. `/api/health` 를 1500ms 제한으로 확인하고, 다른 프로그램이 응답하면 3으로 끝나고, 버전이 다르면 설치된 앱 버전이 CLI 버전과 같을 때만 `/api/shutdown` 후 다시 띄우고, 아니면 `server version <x> differs from cli <y>; run install to update` 경고를 내고 실행 중인 서버를 그대로 쓰고, 응답이 없으면 서버를 띄운 뒤 health를 최대 20번 확인합니다. `INBOX_URL` 은 기본 URL을 바꾸고, `INBOX_NO_ENSURE=1` 은 서버 실행을 건너뛰고, `INBOX_WAIT_POLL_MS`(기본 2000)와 `INBOX_ENSURE_POLL_MS`(기본 500)는 확인 간격입니다.

호출자 신원. `--session <id>` 와 `--session-file <path>` 는 호출한 세션을 명시합니다. 세션 ID는 명시한 `--session` > `INBOX_SESSION` > `PI_SESSION_ID` > null 순으로 정합니다. 두 옵션이 없으면 env 동작은 그대로입니다. `--session` 만 주면 파일은 null로 기록하고, `--session-file` 은 준 값 그대로 기록하며, 그것만 주면 ID는 위 순서대로 정합니다. 경로를 읽거나 추측하지 않습니다. 값이 없거나 비었거나 `--` 로 시작하면(다음 옵션을 먹게 되면) 사용법 오류입니다. 종료 코드 1이며 `ensure` 와 모든 네트워크 호출보다 먼저 검사합니다. 다른 옵션 해석, 모르는 옵션 처리, 받아들이는 ID 형식은 바뀌지 않습니다. `sessionOf` 가 CLI의 유일한 소유 결정 지점입니다. `submit` 은 `identity.session` 으로, `revise`, `reply`, `close` 는 `session` 으로 보내고, `pending` 은 그것으로 조회합니다. `submit` 과 `revise` 는 서버의 `summary.owner` 로 `owner:` 줄을 출력하고, `--json` 출력은 그대로입니다.

소유. 바뀌지 않은 재제출(같은 hash, `existing`)은 소유자 없는 보드라도 기존 소유자, 안, 이벤트 수를 그대로 둡니다. 다른 세션이 명시적으로 `revise` 하면 소유가 옮겨질 수 있고, 자동으로 가져가는 일은 없습니다. 세션 없이 손으로 쓰는 것도 허용되며 보드는 소유자 없이 남습니다. env가 프로세스 경계를 늘 넘는 것은 아니므로(monitor 레인이나 env가 지워진 셸은 `INBOX_SESSION` 을 잃을 수 있음) 그런 레인의 에이전트는 `--session` 을 직접 넘깁니다. `pending --session <id>` 는 그 id로 `/api/here` 를 부르므로 그 세션을 살아 있는 것으로 세기도 합니다(90초 안에 `/api/here` 를 부른 세션이 살아 있는 세션). cwd 신원은 지금의 제품 키(remote 없으면 `dir/<name>`) 그대로입니다. 소스 변경은 설치 사본을 갱신한 뒤에야(`inbox install`, 이어서 `/reload` 나 재시작) 실제 세션에 반영됩니다.

Windows에서는 서버를 `Win32_Process.Create`(PowerShell, 숨김)로 만들어 호출한 터미널이 닫혀도 살아남게 합니다. WMI가 실패하거나 env 키 중 `OMO_INBOX_` 또는 `INBOX_` 로 시작하는 것이 있으면 분리된 `spawn` 으로 대신합니다.

## 보드 형식
보드는 `board.json`(스키마 `visual-board/1`)과 그것이 참조하는 파일이 담긴 폴더입니다.

```
{ title: string (필수, 비어 있으면 안 됨),
  lead?: string,
  sections?: [{ title: string, desc?: string,
    cards: [{ badge?, title?, layout?: 'one'|'two'|'', diagram?: boolean, gray?: boolean, note?, say?,
              frames: [[label, path], ...] (>= 1) }] }],
  questions?: [{ id: /^[A-Za-z0-9_-]{1,40}$/ 고유, text, help?,
    options: [{ value: /^[A-Za-z0-9_.-]{1,60}$/ 질문 안에서 고유, label, rec?: boolean, why? }] (>= 2) }],
  commentPlaceholder?: string,
  kind?: 'decision'|'report' }
```

- `kind` 가 없으면 `decision` 입니다. 다른 값은 `kind` 를 가리키는 오류입니다. `report` 보드는 질문 없는 완료 보고이므로 `questions` 항목이 하나라도 있으면 `questions` 를 가리키는 오류입니다.

- 엄격합니다. 다른 키는 오류입니다. 프로토타입의 최상위 `id` 는 무시하고, `sideSession`(문자열)은 `정할 것` 위에 회색 메모로 보입니다.
- 그림 라벨은 보드 전체에서 고유합니다. 표시는 라벨로 그림을 가리킵니다.
- `say`(카드)는 `듣기` 가 그 카드의 제목 다음에 메모 대신 읽는 말입니다. 그림을 귀로 듣고 알 수 있게 한국어로 씁니다.
- 그림 최대 60개, 질문 최대 30개. 그림이나 질문이 하나 이상 있어야 합니다.
- 그림 경로는 로컬 파일만 됩니다. URL과 절대 경로는 오류(`download the image into the board dir`)이므로 기록은 보여 준 그림을 모두 간직합니다. 상대 경로, 슬래시만, `:` 없음, 빈 / `.` / `..` 조각 없음, 200자 이하, 확장자 `.png .jpg .jpeg .gif .webp .svg .mmd`, 보드 폴더 안의 일반 파일.
- 모으는 파일: `board.json`, 참조된 그림 전부, 각 `x.svg` 옆에 `x.mmd` 가 있으면 그것도. 폴더를 훑지 않습니다. 파일 하나 20 MiB 이하, 합계 100 MiB 이하.
- 오류는 영어로 한 줄에 하나씩, JSON 경로를 앞에 붙입니다. 예: `questions[1].options: must have at least 2 options`.

동작하는 예시는 `skill/example/` 에 있습니다.

## Inbox 페이지
### 대화 목록 (`/`)

머리글에 `Inbox`, `알림 받기` 버튼, **Review** 버튼, `🙋 N`(내 차례인 대화 수, 숨긴 대화는 세지 않음)이 있습니다. Review 버튼에는 나를 기다리는 Review 수(`reviews.mine`, 보고 Review 포함)를 둥근 배지로 답니다. 0이면 배지가 없고, 5초마다 목록을 다시 읽을 때 같이 바뀝니다. 대화마다 한 줄: 제목, 제품과 브랜치, 상태(칩 `🙋 내 차례`, 가장 최근 항목이 막힘이면 `⛔ 막힘`, 알림이면 `🔔 알림`, 세션이 꺼져 있으면 회색 `세션 꺼짐` 칩도), 가장 최근 항목의 제목과 시각, 안 읽은 수, 프롬프트 캐시가 따뜻한 동안의 🔥 표시. 나를 기다리는 대화가 먼저(오래 기다린 순), 그다음 작업 중, 그다음 끝난 대화(최근 순)입니다. 나를 기다리는 대화 묶음의 제목은 `내 차례` 입니다. 숨긴 대화는 맨 끝 묶음 `숨긴 대화 N` 에만 나오고 기본으로 접혀 있습니다. `펼치기` / `접기` 로 바꾸고, 펼친 상태는 브라우저마다 `localStorage` 키 `inbox.hiddenOpen` 에 남습니다. 다음 판정이 있는 내 차례 줄은 상태 칩 바로 뒤에 회색 칩을 답니다: `할 일 없음`(done), `실행 대기`(plan), `마무리 남음`(ship). 세션이 종료됐고 판정이 plan이나 ship인 끝남 줄도 같은 칩을 답니다. ask, blocked, stalled 줄에는 없습니다.

대화 제목은 한국어인 세션 이름, 아니면 모델이 첫 요청으로 지은 한국어 제목(omo는 세션 이름을 영어로 붙이므로 보통 이쪽), 그것도 없으면 24자로 자른 `요청: <첫 요청>` 입니다. 세션 없는 공지는 `알림` 대화로 갑니다.

나눠 보기. 창 너비가 720 CSS px 이상(`min-width: 720px`)이면 넓은 창, 그보다 좁으면 좁은 창입니다(휴대폰, 접은 Galaxy Z Fold). 넓은 창에서 `/` 는 창 너비를 다 쓰는 두 칸으로 나옵니다. 왼쪽은 340 px 고정 너비의 목록으로 따로 스크롤되고, 오른쪽은 고른 대화의 `/s/<sid>` 를 담은 `<iframe>` 이 테두리 없이 나머지 너비와 창 높이를 채웁니다. 고른 대화는 URL에 `/?s=<sid>` 로 남고 해시도 유지됩니다(`/?s=<sid>#<itemId>` 는 `/s/<sid>#<itemId>` 를 엽니다). 줄을 눌러도 페이지는 이동하지 않습니다. `history.pushState` 로 `/?s=<sid>` 를 넣고, 오른쪽을 바꾸고, 그 줄을 선택 표시(`aria-current="page"`)하므로 뒤로 가기는 앞서 고른 대화로 돌아갑니다. 5초 목록 갱신 뒤에도 선택은 남습니다. `?s=` 가 없으면 첫 줄을 고르고(`history.replaceState`), 목록이 비면 오른쪽 칸도 비어 있습니다. 목록에 없는 `?s=` 도 그대로 열고, 대화 페이지가 자기 없음 상태를 보입니다. 좁은 창에서 `/` 는 예전과 같은 목록 하나이고, `?s=<sid>` 가 있는 URL은 해시를 붙인 `/s/<sid>` 로 바꿉니다. 나눠 보기는 대화에만 있습니다. Review(`/boards`, `/p/<id>`)는 어떤 너비에서도 전체 페이지입니다.

### 대화 페이지 (`/s/<sid>`)

- 위 막대: `‹ Inbox`, 제목, 제품·브랜치 칩, 상태 칩(내 차례면 `🙋 내 차례`, 가장 최근 항목이 막힘이면 `⛔ 막힘`), 세션이 꺼져 있으면 회색 `세션 꺼짐` 칩, 🔥 표시. `과정 보기` 왼쪽에 **숨기기** 버튼이 있고, 숨긴 대화에서는 **숨김 해제** 로 바뀝니다.
- 에이전트 말풍선(왼쪽, 흰색): 종류 칩(질문 / 승인 요청 / 권한 요청 / 보고 / 막힘 / 끝남 / 진행 / 알림 / Review), 굵은 제목, 회색 `하던 일 · <context>`, 본문, 묻는 것, 선택지 버튼(★권장이 이유와 함께 맨 위, 여러 개 고르는 질문은 체크박스와 보내기, 질문마다 직접 쓰기 칸), 회색 `답이 없으면 · ...` 줄, 그리고 듣기, 원문 보기(원문을 마크다운으로 보여 줌: 제목, 목록, 인용, 표, 코드, 굵게, 기울임, https 링크. 원문 속 HTML은 글자 그대로), 더 쉽게(더 쉬운 요약 요청), 제보(이 메시지의 문제 제보), 시각이 있는 아래 줄.
- 내 말풍선(오른쪽, 노란색): 보낸 내용과 상태. `보내는 중`, `전달됨 ✓`, `늦게 전달됨`, `세션이 꺼져 있어 다시 열면 전달됩니다`. 60초가 지나도 전달 확인이 없으면 다시 보내기가 나옵니다.
- 시스템 줄(가운데, 회색): `터미널에서 답함`, `다음 작업으로 넘어감`, `시간 초과`, `Review · 열기`. 진행 항목은 상태와 상관없이 배경 없는 회색 한 줄 `<headline>` 이라, 에피소드의 줄들이 마지막 메시지 위에 남습니다.
- 시스템 줄 추가: `closed-by-owner` 로 닫히면 `닫음`, `handed-off` 로 닫히면 `새 세션으로 넘어감`. 새 세션을 띄우면 `새 세션을 여는 중`, 새 세션이 연결되면 `/s/<새 sid>` 로 가는 `새 세션에서 이어감 · 열기` 가 나옵니다.
- 머리의 `과정 보기` 토글(기본 켬, `localStorage` 키 `inbox.progressLines` 에 저장)이 진행 줄을 숨기거나 보입니다.
- 세션이 기다리는 동안 가장 최근 줄에 ` · 기다리는 중: <label>`(백그라운드 작업, 모니터, 분리 실행 작업, 하위 작업, 작업 흐름, Review 답, 질문 답, 권한 답, 목표 이어가기, 다시 불러온 뒤 확인. 보류 `hold:<source>`는 그 source의 이름으로, 그 밖의 사유는 다음 신호로 읽힙니다)이 붙고, 기다리는 desk 보드마다 새 탭으로 여는 `<title> · 열기` 가 붙습니다.
- 에피소드 마지막 메시지의 원문 보기는 에피소드를 불러와 구간의 메시지를 모두 차례대로, 시각과 함께 마크다운으로 보여 줍니다. 불러오기에 실패하면 `다시 시도` 가 나옵니다. `meta.episode` 가 없는 항목은 예전처럼 자기 원문을 보입니다.
- 아래 입력칸: 빠른 답 칩 계속해 / 승인 / 진행 / 멈춰(가장 최근 열린 항목이 turn, blocked, done이거나 대화가 작업 중일 때), `답장` 칸, 보내기. 나를 기다리는 가장 최근 열린 항목에 답하고(질문은 의견, 턴은 답장), 열린 항목이 없으면 자유 메시지를 보냅니다.
- 다음 줄: 다음 상태가 done, plan, ship, blocked, stalled인 가장 최근 열린 마지막 메시지의 말풍선은 물음 줄 뒤에 `다음 · <reason>` 을 보입니다. ask인 마지막 메시지에는 다음 줄이 없습니다.
- 다음 행동 막대: done, plan, ship이면 네 칩을 숨기고 다음 행동이 그 자리에 옵니다. 주 행동은 강조색입니다. ask, blocked, stalled이면 칩은 그대로 두고 그 뒤에 제공자 행동과 간격을 둔 외곽선 버튼 `세션 닫기` 를 둡니다. 누르면 응답이 올 때까지 다음 행동 버튼이 모두 잠깁니다. 버튼은 칩과 같은 줄에 같은 크기·모양으로 놓입니다.
- 이어가기 행동(`커밋·푸시`, `푸시`, 모델과 제공자 프롬프트)은 답장처럼 보내므로, 세션의 다음 실행이 마지막 메시지를 넘기고 입력칸은 작업 중 칩으로 돌아갑니다. 세션이 꺼져 있으면 먼저 다시 열기 시트를 엽니다.
- 닫기 시트: 경고가 있는 닫기, 또는 서버의 `confirm_required` 응답은 경고를 하나씩 적은 `세션을 닫을까요?` 시트를 `닫기`, `취소` 와 함께 엽니다. 경고가 없으면 바로 보냅니다. 상태는 `세션을 닫는 중입니다.`(살아 있는 세션) 또는 `세션을 닫았습니다.`(꺼진 세션).
- 새 세션 시트: 언제나 `새 세션에서 실행할까요?` 를 `폴더 · <dir>`, `첫 메시지 · /skill:ulw-execute <slug>`, `실행`, `취소` 와 함께 묻습니다. 상태는 `새 세션을 여는 중입니다.`, 그 뒤 새 대화로 가는 `열기` 가 붙은 `새 세션을 열었습니다.`.
- 행동 오류: `계획 파일을 찾지 못했습니다.`(plan_missing), `상황이 바뀌었습니다. 다시 확인해 주세요.`(stale, 페이지는 곧바로 새로 고칩니다), 그리고 다시 열기 문구 `세션 폴더가 없어 열지 못했습니다.`, `터미널을 찾지 못했습니다.`, `세션을 열지 못했습니다.`, `이 기기에서는 열 수 없습니다.`. 60초가 지나도 확인되지 않은 행동 말풍선은 다시 보내기 대신 `세션이 응답하지 않습니다` 를 보입니다.
- 종료된 세션(행동 가능한 닫힌 마지막 메시지, 다음 행동 절 참고)은 인계가 생길 때까지 입력칸 자리에 계획 행동과 이어가기 행동을 둡니다. 이어가기는 다시 열기 시트를 거칩니다.
- 용어: 제목, `하던 일`, 본문, 묻는 것에 나오는 요약 용어는 점선 밑줄 버튼입니다. 누르면 말풍선 안, 그 낱말 바로 아래에 뜻을 담은 팝오버가 뜹니다. 다시 누르거나 바깥을 누르거나 Escape를 누르면 닫히고 초점은 낱말로 돌아갑니다. 한 번에 하나만 열리고, 주기적으로 다시 그려도 열린 채로 남습니다. `용어 ·` 줄은 없습니다.
- 에이전트 말풍선 아래 줄은 듣기로 시작합니다. 누르면 제목, `하던 일` 과 맥락, 본문, 묻는 것, 말풍선에 보이는 선택지(질문 문구, 그다음 번호, 라벨, 추천, 이유. 권한 요청은 버튼 이름)를 한국어(ko-KR)로 읽습니다. 읽는 동안 버튼은 멈추기, 끝나면 다시 듣기입니다. 다른 메시지를 읽기 시작하면 앞의 것은 멈추니 한 번에 하나만 나옵니다. 누르지 않으면 아무것도 읽지 않고, 브라우저에 음성 기능이 없으면 버튼을 숨깁니다.
- 다시 열기 시트: 세션이 꺼진 대화에 무엇이든 보내면(입력칸, 빠른 답 칩, 선택지, 권한 버튼, 의견이나 답장, 다시 보내기) 먼저 시트가 뜹니다. 제목은 `세션이 꺼져 있습니다`, 설명은 `다시 열면 이 답을 바로 전달합니다.`, 버튼은 `다시 열고 보내기` 와 `나중에 전달` 입니다. Escape나 어두운 바탕을 누르면 보내지 않고 닫히며 쓴 글은 남습니다. `나중에 전달` 은 예전처럼 답을 저장합니다. `다시 열고 보내기` 도 똑같이 저장하고, 저장이 됐을 때만 PC에 세션을 다시 열어 달라고 합니다(세션 깨우기와 수집 참고). 입력칸 상태 줄은 `세션을 여는 중입니다.` 다음에 `세션을 열었습니다. 연결되면 전달됩니다.`, `세션 폴더가 없어 열지 못했습니다. 답은 다음에 열 때 전달됩니다.`, `열 세션을 찾지 못했습니다. 답은 다음에 열 때 전달됩니다.`, `터미널을 찾지 못했습니다. 답은 다음에 열 때 전달됩니다.`, `세션을 열지 못했습니다. 답은 다음에 열 때 전달됩니다.`, `이 기기에서는 열 수 없습니다. 답은 다음에 열 때 전달됩니다.` 중 하나가 되고, 세션이 이미 살아 있었으면 비웁니다. 더 쉽게는 시트를 거치지 않습니다. 숨기기에 실패하면 같은 줄에 `숨기지 못했습니다.` 가 나옵니다.
- 페이지가 보이는 동안 3초마다 `GET /api/threads/<sid>?since=` 를 부릅니다. 세션 글은 항상 글자로 넣고 HTML로 넣지 않습니다.
- 넓은 창에서 최상위 창으로 열리면(열 때나 너비가 바뀔 때) 해시를 붙인 `/?s=<sid>` 로 바뀌므로, 알림을 누르면 나눠 보기로 옵니다. 나눠 보기의 iframe 안에서는 끼워진 모드입니다. `<html>` 에 `data-embed` 가 붙고, `‹ Inbox` 를 숨기며, 다른 페이지로 가는 링크(`/p/...`, `/boards`)는 최상위 창에서 엽니다(`<base target="_top">`, `target="_blank"` 링크는 그대로). 끼워진 페이지는 바꿔 이동하지 않습니다. 나머지는 위와 같습니다.
- 폰에서 질문 도구에 닿을 수 없으면 말풍선에 `터미널에서 답해 주세요`, reload 뒤에는 `리로드 후에는 터미널에서 답해 주세요` 가 나오고, 폰 답은 후속 메시지가 됩니다.

새 페이지는 `Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'self'` 을 보냅니다.

### 기획안 페이지 (`/p/<id>`)

Review 목록은 `/boards` 에 있습니다(제목과 머리말 `Review`, 탭 제목 `(N) Review`, 상태 거르기와 칩 `🙋 내 차례`). 페이지 글에서는 Review라고 부릅니다(`이 Review를 AI와 이야기하기`, `이미 끝난 Review입니다.`, `Review를 찾을 수 없습니다.`). 소유 세션을 아는 기획안 페이지에는 그 대화로 가는 `‹ 대화` 링크가 있습니다.

- 페이지 안의 그림: 마우스나 펜으로 그림 위를 끌면 그 자리에서 번호 붙은 네모가 그려집니다. 터치는 페이지 안에서 그리지 않으므로 그림 위에서 손가락을 움직이면 페이지가 스크롤됩니다.
- 끌지 않고 그림을 탭하거나 클릭하면(움직임 8 px 미만) 그 그림이 뷰어에서 전체 화면으로 열립니다. 그림 파일과 렌더된 `.mmd` 도식 모두 됩니다.
- 뷰어는 페이지 위에 뜨는 대화 상자이고, 위 막대에 그림 라벨, `표시하기`, `닫기` 가 있습니다. 그림은 처음에 화면에 맞춰 보입니다. 두 손가락 핀치로 두 손가락 가운데를 중심으로 확대·축소(1배~8배)하고, 한 손가락이나 마우스 드래그로 이동하고, 마우스 휠은 커서를 중심으로 확대·축소합니다. 그림을 화면 밖으로 끌어낼 수는 없습니다.
- `표시하기` 는 네모 하나를 그릴 준비를 합니다. 한 손가락이나 마우스로 그리면(두 손가락은 여전히 핀치) 버튼은 다시 꺼집니다. 여기서 만든 네모는 페이지 안에서 만든 것과 같습니다. 그림 기준으로 정규화되고, 번호가 붙고, `표시한 곳` 에 나열되고, 크롭과 함께 의견으로 전송됩니다.
- 이 그림의 네모는 뷰어에도 그려집니다. 네모를 탭하면 선택되고, 새로 그린 네모는 선택된 채로 시작합니다. 그러면 뷰어 아래쪽에 번호, 의견 칸, `지우기` 가 나타납니다. 의견은 `표시한 곳` 목록에 보이는 것과 같고, `지우기` 는 모든 곳에서 네모를 지웁니다. 네모 밖을 탭하면 아래쪽 칸이 들어갑니다. 화면 키보드가 올라오면 칸은 키보드 위로 옮겨집니다.
- 지난 안이나 끝난 기획안에서도 뷰어는 확대·이동용으로 열리지만 `표시하기` 와 아래쪽 칸은 없습니다.
- 2안부터 제목과 요약 사이에 `이 안이 나온 이유` 카드(보고 보드는 `이 갱신이 나온 이유`)가 나옵니다. 보고 있는 안이 나오게 된 과정을 차례대로 보여 줍니다: 앞 안에 보낸 내 의견, 세션 답, 그리고 고친 안의 메모. 줄 모양은 `대화` 와 같고, `대화` 는 아래에서 모든 이벤트를 그대로 보여 줍니다. 1안에는 카드가 없고, 앞에 의견, 답, 메모가 하나도 없는 안에도 없습니다.
- `대화` 와 `이 안이 나온 이유` 카드는 하늘색 바탕의 대화처럼 보입니다: 내 의견(답, 의견, 네모)은 이름 없이 오른쪽 노란 말풍선, 세션 답은 `🤖 세션 답` 이름을 단 왼쪽 흰 말풍선, 제출·고친 안·끝남은 가운데 작은 줄과 회색 띠의 메모로 나옵니다.
- `재요청` 은 답, 의견, 네모를 보내고 세션에 수정안을 요청합니다. 셋 중 하나는 있어야 합니다. `승인` 은 같은 내용을 보내면서 기획안을 승인합니다. 세션은 다시 보여 주지 않고 작업한 뒤 기획안을 닫습니다. 대화 기록에는 승인만 표시됩니다. 두 버튼은 처음 누를 때 잠기므로 한 번 누르면 한 번만 보냅니다. 보내지면 Inbox로 돌아가고, 실패하면 이유를 보이며 페이지에 남습니다. 닫기 버튼은 없습니다. 작업이 끝나면 세션이 `inbox close` 로 기획안을 닫습니다.
- 보고 보드(`kind: report`)는 `재요청` 과 `승인` 대신 `확인` 버튼 하나를 보입니다. 의견과 네모를 담아 verdict `ack` 를 보냅니다. 머리글에 `보고` 칩이 붙고, 안 탭, 이벤트 표시, 새 안 배너는 `n안` 대신 `갱신 n` 으로 읽으며, `정할 것` 카드는 질문 없이 `확인` 으로 보입니다. `kind` 가 없는 요약은 결정 보드로 그립니다.
- Inbox는 보고 보드에 `보고` 칩과 `갱신 n` 을 보이고, `보고 N` 개수를 보이며, 열린 보고 보드를 결정 보드 다음에 따로 제목을 달아 묶습니다.
- `닫기`, Esc, 휴대폰의 뒤로 가기 동작으로 닫습니다. 뷰어는 히스토리 항목 하나이므로 뒤로 가기는 뷰어만 닫고 페이지는 그 자리에 남습니다.
- 제목 옆 `듣기` 는 보고 있는 안을 기기 자체 목소리(Web Speech `speechSynthesis`, 한국어)로 읽습니다. 순서: 가장 최근 일이 세션 답이면 그 답, 2안부터는 `이 안이 나온 이유` 카드(그 안의 의견과 답, 그다음 고친 안의 메모), 제목, 요약, 구획마다 구획 제목과 카드별 제목과 `say`(없으면 메모), 질문마다 선택지(추천인 것은 추천이라고 말하고 `why` 도 읽음), 마지막으로 `여기까지입니다`. 읽는 동안 버튼은 `멈추기` 가 되고, 화면이 넘어가도 왼쪽 아래에 떠 있는 `멈추기` 가 남아 있으며, 읽고 있는 카드에 테두리가 생기며 화면 가운데로 옵니다. 중간에 멈추면(`멈추기`, 음성 엔진 오류, 페이지가 뒤로 가 있는 사이 엔진이 말을 끊은 경우) 버튼은 `이어 듣기` 가 되어 읽던 조각부터 이어 읽고, 옆의 `처음부터` 는 처음부터 읽습니다. 끝까지 읽으면 다시 `듣기` 가 됩니다. 다른 안으로 바꾸면 멈추고 읽던 자리도 잊습니다.
- 말로 답하려면 `전체 의견` 에서 폰 키보드의 마이크를 씁니다. 의견 하나로 모든 질문에 답해도 됩니다.

### 제보 페이지 (`/issues`)

- 입구. `제보` 는 `/`, `/s/<sid>`, `/boards`, `/p/<id>` 의 위 도구와 전체 화면 뷰어의 `.vbar` 에 있는 실제 `<a data-issue-report href="/issues/new">` 입니다. JS가 이것을 보강하고, 원본 스크립트가 실패해도 보통 링크 이동으로 `/issues/new` 가 열립니다. 독립 페이지는 페이지 수준의 출처 힌트만 보이고, 실패한 페이지를 수집한 척하지 않습니다.
- 작성창. `문제 제보` 는 설명 칸에서 열리고, 그 설명이 유일한 필수 칸입니다(여러 줄 자유 글 또는 키보드 받아쓰기). 제목, 심각도, 유형, 단계, 기대 결과 입력은 없습니다. 순서: 바꾸기/지우기가 있는 위치 칩, 설명, `첨부 확인` 이 있는 첨부 요약, 브라우저가 지원할 때만 나오는 선택 `사진 추가`/`화면 캡처`, 전송 상태, `보내기`. 기본 위치는 지금 페이지/기록이고 `위치 선택` 은 선택입니다.
- 닫기, Escape, 뒤로 가기는 저장된 초안을 남깁니다. `초안 버리기` 는 지우기 전에 확인을 받습니다. 성공하면 `접수했습니다` 라고 알리고 제보 링크를 보여 주며 초점/스크롤을 되돌립니다. 원래 페이지에 머물고 Inbox로 이동하거나 ack를 보내지 않습니다.
- `/issues` 는 `제보함` 목록, `/issues/new` 는 독립 작성창, `/issues/<uuid>` 는 상세입니다. 목록과 상세는 `web/issues.html`/`web/issues.js` 를 함께 씁니다. 머리의 `제보함` 링크 배지는 `needs-check` 만 세며 Review와 `내 차례` 수와 별개입니다.
- 상태는 `open`(`접수`), `investigating`(`조사 중`), `needs-check`(`확인 요청`), `resolved`(`해결`), 그리고 끝난 삭제 표석입니다. 의견과 덧붙인 증거는 상태를 바꾸지 않고, 관리자의 분류는 `open`/`investigating` 을 `investigating` 으로, 수정 확인 요청은 `open`/`investigating`/`needs-check` 에서 `needs-check` 로, 소유자 확인은 `needs-check` 를 `resolved` 로, 소유자 다시 열기는 `needs-check`/`resolved` 를 `open` 으로, 소유자 삭제는 표석으로 HTTP API 절의 규칙대로 움직입니다. 상세는 처음 관찰 시각/빌드, 서버 접수 시각/빌드, 현재 출처 링크, 수정 산출물, 소유자 확인을 각각 라벨 붙은 줄로 나눠 보입니다.
- 전체 화면 뷰어는 `.vbar` 에 자기 `제보` 동작을 얻습니다. 원본 그림, 확대, 표시는 그대로입니다. 제보 대화 상자는 `#comment`, `state.marks`, `#ackBtn`, `#reply` 와 별개입니다.
- 기존 화면에 넣은 입구는 옆 조작과 같은 크기와 모양을 씁니다. 말풍선 아래 줄의 `제보` 는 그 줄의 글자 버튼 중 하나이고, 머리의 `제보함`·`제보` 는 각 화면 머리의 기존 링크나 도구와 같습니다. 제보 작성창과 제보함 화면은 최소 44 CSS 픽셀의 누름 영역을 유지합니다. 모든 상태는 색만이 아니라 글자로도 읽히고, 새 화면은 상속된 어두운 설정을 따르며 예전 페이지 색은 바꾸지 않습니다. 캡처는 절대 저절로 하지 않으며, 결과가 불확실한 전송은 `접수 확인 중` 으로 보이고 receipt 전에는 접수됐다고 말하지 않습니다.
- 문맥. 보내기 전에 작성창은 남길 문맥 항목을 모두 미리 보여 주고, 항목마다 지울 수 있습니다. 지워도 설명은 그대로입니다. 문맥은 허용 목록에 든 봉투 필드(출처 참조, 대상, 보기, 선택한 발췌, 보이는 기록 id, 태그 붙은 진단, 수집 상태, 그림 출처)로만 제한하므로 임의 선택자, outerHTML, 입력값, DOM 속성은 저장하지 않습니다. 글은 보이는 `선택한 내용 포함` 토글로 선택하며, 특정 기록에서 연 경우에만 기본으로 켜지고 페이지 수준 제보는 문맥만 담고 글은 담지 않습니다. 진단은 정해진 동작 이름, 경로 템플릿, 숫자 상태/시간, 안정된 오류 코드, 스크립트 파일 이름/줄/열/오류 종류만 담습니다. 원본 오류 문구와 스택, 헤더, URL 질의/해시, IP, 사용자 에이전트, 저장소 내용, 입력값, 클립보드 글, 서버 로그 끝, cwd, 세션 파일 경로는 넣지 않습니다. 자격 증명 모양 가리기는 발췌, 설명, 의견, 표시 글에만 적용하고, 가린 제출을 확인할 때까지 미리보기에는 원문을 둡니다. 서버는 저장 전에 같은 가리기를 다시 하고 원문을 곁 파일에 남기지 않습니다.
- 계약 한도: 설명 1..8192 UTF-8 바이트, 의견/메모 1..4096 바이트, 서버가 만드는 제목 80 유니코드 코드 포인트까지, 고른 발췌 8192 바이트까지, 보이는 기록 id 50개까지, 앞선 30초의 진단 이벤트 30개까지, 래스터 한 변 4096 이하이면서 2,097,152 픽셀까지, 표시/가리기 각각 50개이며 표시 메모는 각각 256 UTF-8 바이트까지, 입력 그림 파일 10 MiB까지, 목록과 이벤트/증거 메타데이터 쪽은 기본 50개·최대 100개, 출처 id 1..200 바이트와 대상 키/라벨 각각 160 바이트까지, 문맥 32 KiB 정규 JSON까지. 글은 조용히 자르지 않고 거부합니다. 접수된 제보와 대기 중인 제보는 저절로 만료되지 않으며, 삭제는 소유자가 명시적으로 할 때만 끝나는 동작입니다.
- 조회 중이거나 안이 바뀌어도 제보의 출처는 바뀌지 않습니다. 어댑터 등록을 쓸 수 없으면 `contextStatus:"unavailable"` 로 `/issues/new` 로 낮추고 글 제보는 계속 쓸 수 있습니다.

## 데이터 구조
```
<home>/
  app/                 저장소의 설치 사본
  data/proposals/<id>/ 기록 (서버만 씀)
    proposal.json      { v: 1, id, title, created, product, feature, session, kind }, 한 번만, 마지막에 씀
    revs/<n>/...       안마다 복사한 보드 파일
    events/<seq6>-<type>.json
    crops/<seq6>-<n>.png
  data/threads/<sid>/  세션 대화마다 폴더 하나
    thread.json        { v: 1, session, cwd, product, feature, worktree, branch, title, titleSource, firstRequest, created, ended, sessionFile, hidden }
    events/<seq6>-<type>.json   item, summary, answer, delivered, bridge, state, pushed, closed, activity, cache, read, next, actions, handoff
  data/issues/         독립 제보 저장소 (서버만 씀)
    store.json         { v, storeId }
    records/<issueId>/created.json
    events/<seq6>.json
    evidence/<captureId>/{context.json,image.png,manifest.json}
    tombstones/<issueId>.json
  data/live.json       세션 -> 마지막 /api/here 시각(epoch ms). 서버를 다시 시작해도 살아 있음을 되살림
  mailbox/<session>/<file>.json   확장을 기다리는 답과 보드 의견. 전달 후 지움
  ledger/<session>.json   확장이 이미 처리한 전달 id
  control/<session>/<deliveryId>.json   확장을 기다리는 세션 제어 파일(close, run)
  takeover.json        takeover가 쓰고 handback이 이름을 바꿈
  push/vapid.json      서버의 VAPID 키 쌍. 한 번만 만듦
  push/subscriptions.json   알림을 켠 브라우저들
  logs/  config.json  server.json  launch-hidden.vbs
```

대화:

- 항목 id는 `i-YYMMDD-xxxxxx`. 종류 `question permission turn blocked done progress board notice`, 정책 `needs-you progress quiet fyi`. `_notices` 대화는 세션 없는 공지를 담습니다.
- 에피소드 항목에는 `meta.episode` 가 있습니다. 줄(`progress`)은 `{key, seq, opener, openedAt}`, 마지막 메시지는 `{key, opener, openedAt, closedAt, closeReason, lines, turns, interjections, questions}`. 키는 `e:<sid>:<에피소드가 열릴 때 세션 기록 마지막 항목의 시각>` 이라 확장 사본마다 같은 키가 나옵니다.
- `state` 이벤트 `{state: "waiting"|"resumed", reasons, boards}` 는 줄이 기다리는 이유를 적고, 항목은 가장 최근 것을 `item.state` 로 보입니다. `pushed` 이벤트는 항목의 푸시를 보냈다는 기록이라, 서버를 다시 시작해도 다시 보내지 않습니다.
- `activity` 이벤트는 `cause`(`owner` 나 `system`, 없으면 `owner`)를 담습니다.
- 항목 상태: 닫혔으면 `closed`, 아니면 답에 맞는 `delivered` 가 없을 때 `answered`, 아니면 `delivered`, 아니면 `open`. 24시간이 지나도 열린 질문과 권한 요청은 `expired` 로 닫힌 것으로 읽습니다.
- `thread.json` 키 `sessionFile`(문자열 또는 null, 기본 null. 확장이 알려 준 세션 파일로, 다시 열기에 씀)과 `hidden`(불리언, 기본 false). 이 키가 없는 예전 thread.json은 null과 false로 읽습니다.
- `thread.json` 키 `executes`(문자열 또는 null, 기본 null): 이 세션이 직접 실행하는 계획 slug로, 첫 입력 원문에서 읽습니다. `next` 이벤트 `{itemId, next}` 는 마지막 메시지의 판정을, `actions` 이벤트 `{producer, actions}` 는 제공자의 목록을, `handoff` 이벤트 `{itemId, to, via, status, slug}` 는 새 세션 띄우기를 저장합니다(`via` 는 `orca`, `wt`, `sink`, `status` 는 `launching`, `connected`).
- 닫힘 이유에 `session-closed`(`세션 닫힘`) 외에 `closed-by-owner`(`닫음`)와 `handed-off`(`새 세션으로 넘어감`)가 있습니다.
- 대화 상태. 세션이 90초 안에 `/api/here` 를 불렀거나 90초 안에 그냥 bye(`/reload`)를 보냈으면 살아 있습니다. 열린 needs-you 항목이 있고 세션이 살아 있거나, 세션이 꺼졌는데 열린 항목이 아직 묻고 있으면(하는 일 참고) `needs-you`, 아니면 살아 있을 때 `working`, 아니면 `ended`. 목록 줄과 대화 보기에는 `live`, `off`(살아 있지 않은데 needs-you, `_notices` 는 늘 false), `hidden` 이 붙습니다.
- `delivered.how` 는 `bridge`, `message`, `late-message`, `dropped`(터미널이 먼저 답함), `refused`, `control`(세션 제어 파일 적용).
- 우편함 파일은 `{v:1, type, ...}`: `item-answer`(itemId, kind, deliveryId, payload, text), `explain`(itemId), `board-feedback`(desk의 형식. `type` 없는 파일은 보드 의견).

기획안:

- id는 `YYMMDD-xxxx`. JSON은 모두 임시 파일에 쓴 뒤 이름을 바꿉니다. 안은 `revs/<n>.tmp-<rand>` 에 복사한 뒤 다 되면 이름을 바꾸고, 색인 재구성은 `proposal.json` 이 없는 폴더와 `*.tmp-*` 폴더를 무시합니다.
- 이벤트: `submitted`, `feedback`, `reply`, `revised`, `closed`. 1부터 번호를 매기고 재사용하지 않습니다. `submitted` 와 `revised` 는 내용 `hash` 를 가집니다.
- 상태: `closed` 가 있으면 `closed`, 아니면 세션 답장을 건너뛰고 마지막이 `feedback` 일 때 `theirs`(내 의견이 세션을 기다리는 중, 승인이면 `approved`), 그 외는 `mine`(내 답을 기다리는 중). 답장은 상태를 바꾸지 않습니다. 의견 뒤에는 세션이 수정안을 올리거나 닫을 때까지 `theirs` 로 남습니다. 화면에는 `끝남`, `🤖 처리 중`, `🙋 내 차례` 로 나옵니다.
- 소유자는 세션 id가 있는 마지막 이벤트의 세션입니다.
- `kind` 는 제출 때 `proposal.json` 에 쓰고 모든 요약에 `kind` 로 보입니다. 없는 기록은 `decision` 으로 읽습니다. revise는 kind를 유지하고, 보드의 kind가 다른 revise는 400 `bad_input` 입니다.
- verdict: 결정 보드는 `change` 와 `approve`, 보고 보드는 `ack` 만(의견과 표시는 선택, 답 없음). 다른 조합은 400 `bad_input` 입니다. 의견도 표시도 없는 `ack` 은 의견 이벤트를 쓰고 같은 호출에서 `closed` 이벤트 `{ by: "user", summary: null }` 를 쓰며 우편함 파일은 쓰지 않습니다. 전달할 것이 없으므로 그 의견의 `delivery` 는 `none` 입니다. 의견이나 표시가 있는 `ack` 은 의견 이벤트만 씁니다. 상태는 `theirs` 가 되고, 평소의 우편함과 대기 알림 경로로 라우팅·전달되며, 소유 세션이나 다음 세션이 `inbox close` 로 닫습니다.
- 열린 상태에서 같은 기능 + 제목으로 다시 올리면, 내용 hash가 같을 때 기존 기획안을 돌려주고 다르면 종료 코드 8입니다. `--new` 는 항상 새로 만듭니다.
- 의견의 `delivery` 는 계산값입니다: `none`(소유자 없음, 전달할 것 없음(의견도 표시도 없는 `ack`), 또는 우편함 쓰기 실패. 이벤트는 저장되고 서버가 한 번 재시도한 뒤 로그를 남김), `pending`(우편함 파일 있음), `delivered`.
- 전달 문구(우편함 파일의 `text`, `inbox wait` 도 같은 문구를 출력)는 `처리:` 줄로 끝납니다. `재요청` 이면 세션에 `inbox revise` 로 수정안을 올리라고 하고, 재요청은 승인이 아니니 확정하거나 작업을 시작하지 말라고 적습니다. `승인` 이나 `확인` 이면 `reply / revise / close` 를 나열합니다.
- 제품 키는 정규화한 `origin` remote(소문자 `host/path`), 기능 키는 `<제품 키>#<브랜치>`, 개수와 알림의 범위는 워크트리 경로입니다.

`data/issues` 는 `uninstall` 이 나머지 `data` 와 똑같이 간직합니다. 삭제 표석에는 설명, 문맥, 그림을 남기지 않습니다.

`config.json`: `{ "v": 1, "port": 4387, "publicBase": "https://<machine>.<tailnet>.ts.net:4388" | null, "pcTailnetIps": [...], "owner": "<tailscale login>" | null, "baseline443": {...}, "mode": "trial" | "primary", "summary": { "enabled": true, "models": [...] }, "cacheLeadMinutes": 5, "progress": { "modelLines": true }, "episode": { "stallMinutes": 60 } }`. `server.json` 은 서버만 씁니다: `{ "v", "name", "port", "pid", "started", "version" }`. 설치는 쓰지 않습니다. `next.closeTab`(기본 true)은 닫기가 Orca 탭도 닫게 합니다. `false` 면 탭을 남깁니다.

## HTTP API
서버는 `127.0.0.1:4387`. 모든 POST는 `content-type: application/json` 과 `x-inbox: 1` 이 필요합니다(없으면 403). 본문 제한 30 MiB(넘으면 413). `/api/issues*` 는 대신 12 MiB까지만 읽고 JSON을 해석하기 전에 적용하며, 예전 경로는 30 MiB를 그대로 씁니다. `/api/*` 응답은 `cache-control: no-store`, 안 파일은 `public, max-age=31536000, immutable`.

| 메서드 | 경로 | 권한 | 응답 |
| --- | --- | --- | --- |
| GET | `/` | read | 대화 목록 페이지 |
| GET | `/s/<sid>`, `/boards` | read | 대화 페이지, 기획안 목록 페이지 |
| GET | `/p/<id>` | read | 기획안 페이지 |
| GET | `/web/<file>` | read | 정적 파일 |
| GET | `/sw.js` | read | 서비스 워커(`Service-Worker-Allowed: /`, `cache-control: no-cache`) |
| GET | `/files/<id>/revs/<n>/<path>`, `/files/<id>/crops/<file>` | read | 파일. 경로 탈출은 403 |
| GET | `/api/health` | read | `{ ok, name: 'omo-inbox', version, pid, port }` |
| GET | `/api/caps` | read | `{ access, open, targets }` |
| GET | `/api/proposals?product=&feature=&status=` | read | `{ items, facets, counts }` (counts는 거르지 않은 전체 `{ mine, theirs, closed, reports }`, `reports` = 열린 보고 보드) |
| GET | `/api/p/<id>?since=<seq>` | read | `{ proposal, summary, url, revs, events }` |
| POST | `/api/p/<id>/feedback` | feedback | `{ ok, seq, status, routed, delivery }`. verdict는 `change`, `approve`, `ack`(데이터 구조 참고) |
| GET | `/api/push/key` | read | `{ publicKey }` (VAPID, base64url) |
| POST | `/api/push/subscribe` | feedback | `{ ok }`, 이어서 그 브라우저에 환영 푸시 |
| POST | `/api/push/unsubscribe` | feedback | `{ ok }` |
| POST | `/api/open` | open | `{ ok, cmd }` |
| POST | `/api/proposals` | session | `{ summary, url, existing }` |
| POST | `/api/p/<id>/revise` | session | `{ summary, url }` |
| POST | `/api/p/<id>/reply` | session | `{ summary }` |
| POST | `/api/p/<id>/close` | session | `{ summary }` |
| GET | `/api/issues/capabilities` | read | `{ storeId, schema: 1, limits, serverBuild, features }`; no-store |
| GET | `/api/issues?state=&q=&cursor=&limit=` | read | `{ items, counts: { open, investigating, "needs-check", resolved }, nextCursor }`; `q` 200 UTF-8 바이트까지, 제목/설명의 문자 그대로 대소문자 무시 검색 |
| GET | `/api/issues/<id>?after=&limit=` | read | `{ issue, state, currentSeq, events, evidence, nextAfter, capabilities }`; 숫자 `after`/`nextAfter` |
| GET | `/api/issues/<id>/evidence/<captureId>/image` | read | manifest가 고른 정리된 PNG, 또는 404/410; `Content-Type: image/png`, `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'`, `Cache-Control: private, no-store` |
| POST | `/api/issues` | feedback | 201 커밋 또는 200 정확한 재전송; receipt와 currentSeq |
| POST | `/api/issues/<id>/feedback` | feedback | 소유자 `comment`, `append_evidence`, `confirm`, `reopen`, `purge` 명령 |
| POST | `/api/issues/<id>/commands` | session | 관리자 `triage`, `comment`, `request_check` 명령 |
| GET | `/api/here?cwd=&session=[&start=1][&idle=0\|1]` | session | `{ product, feature, mine, theirs, pending, waiting, notice, noticeKeys, footer }` |
| POST | `/api/bye` | session | `{session, closed?}` -> `{ ok }`; `closed: true` 면 그 대화의 열린 항목을 `session-closed` 로 닫음 |
| POST | `/api/shutdown` | session | `{ ok }`, 이후 종료 |
| POST | `/api/threads/<sid>/items` | session | `{kind, policy, dedupeKey, raw, meta}` -> `{item, created, summaryRequest\|null, summaryConfig}` |
| POST | `/api/items/<itemId>/summary` | session | `{text, model, simpler}` -> `{ok, summary}`. 잘못된 요약이면 휴리스틱 요약을 두고 `{ok: false}` |
| POST | `/api/items/<itemId>/close` | session | `{reason, resolvedBy}` |
| POST | `/api/threads/<sid>/activity` | session | `{source, cause}`. `cause` 는 `owner`(기본) 나 `system` |
| POST | `/api/items/<itemId>/state` | session | `{state: "waiting"\|"resumed", reasons(10개까지, 각 40자까지), boards(5개까지 `{id, title 80자까지, url}`, url은 http(s))}` -> `{ok}`. 그 밖은 400 |
| POST | `/api/threads/<sid>/cache` | session | `{warmUntil, ttlSec}` |
| POST | `/api/threads/<sid>/meta` | session | `{title?, ended?, sessionFile?, ...meta}` |
| POST | `/api/items/<itemId>/answer` | feedback | `{answers?, text?, comment?, choice?, feedbackText?}` -> `{ok, deliveryId}`; 409 `{error: "closed", reason}`; 400 `question_incomplete` / `invalid_answer` |
| POST | `/api/threads/<sid>/message` | feedback | `{text}`. 자유 메시지. 열린 항목이 없으면 새 `turn` 항목에 붙음 |
| POST | `/api/items/<itemId>/explain` | feedback | `{ok}`. 세션이 살아 있지 않으면 409 |
| POST | `/api/items/<itemId>/delivered` | session | `{deliveryId, how, detail}`. how `control` 은 세션 제어 파일 확인, `dropped` 는 detail `item closed` 또는 `stale` |
| POST | `/api/threads/<sid>/read` | feedback | `{seq}` |
| POST | `/api/notices` | session | v1 공지(다른 확장의 공지 참고). 400은 `details` 포함 |
| GET | `/api/threads?status=` | read | `{items: rows, counts: {needsYou, working, ended, hidden}, reviews: {mine}}`. 줄에는 `live`, `off`, `hidden` 이 붙고 숨긴 대화도 `hidden: true` 로 들어 있음(`inbox threads --json` 도 같음). `needsYou` 는 숨긴 대화를 세지 않음 |
| POST | `/api/threads/<sid>/hide` | feedback | `{hidden: boolean}` -> `{ok, hidden}`. 400 `bad_input`, 404 `not_found` |
| POST | `/api/threads/<sid>/reopen` | reopen | `{}` -> `{ok, via: "orca"\|"wt"\|"sink", already?}`. 409 `{error: "live"\|"cwd_missing"\|"no_session"}`, 503 `no_launcher`, 502 `launch_failed`, 404 `not_found`, `_notices` 대화는 400 |
| POST | `/api/items/<itemId>/action` | reopen | `{action, confirm?}` -> `{ok, via: "message"\|"session"\|"offline"\|"orca"\|"wt"\|"sink", deliveryId?, off?, session?}`. 404 `not_found`, 400 `bad_input`(없는 행동 id), 409 `{error: "closed", reason}`, `busy`, `off`, `confirm_required` `{warnings}`, `stale` `{next}`, `plan_missing`, `cwd_missing`, 503 `no_launcher`, 502 `launch_failed`, 403 `forbidden` |
| POST | `/api/threads/<sid>/actions` | session | `{producer, actions}` -> `{ok}`. 400 `bad_input` 와 `details` |
| GET | `/api/threads/<sid>?since=` | read | `{thread, items: [item + status + summary + answers], events}`. 진행 항목은 `raw.text` 없이 옴 |
| GET | `/api/threads/<sid>/episodes/<key>` | read | 차례대로 `{request, lines: [{id, at, text, headline}], final: {id, at, text} \| null}`. 마지막 메시지와 같은 마지막 줄은 다시 넣지 않음 |
| GET | `/api/items/<itemId>` | read | 상태와 전달된 deliveryId를 담은 항목 |

항목과 그 보기에는 `next`(계약 형태 또는 null)가 붙습니다. 내 차례 줄과 행동 가능한 닫힌 마지막 메시지가 있는 끝남 줄에는 `next: {state, label}` 또는 null이 붙습니다. 대화 보기에는 `handoff`(`{to, via, status, slug, at}` 또는 null)와 `actions`(제공자 행동)가 더해집니다. `/api/here` 는 세션의 상시 감시 수 `watch=<n>` 을 받습니다.

제보 생성은 `{v:1,storeId,requestId,description,evidence}`, 명령은 `{v:1,storeId,requestId,expectedSeq,command}` 입니다. 변경 성공은 `{ok:true,id,storeId,receipt:{requestId,seq,acceptedAt},currentSeq,state,evidenceManifest}` 이고, 생성 receipt는 seq 1부터 시작하며 정확한 재전송은 새 접수 시각을 만들지 않고 원래 receipt와 현재 상태를 돌려줍니다. 상세는 `{issue:{id,storeId,title,description,createdAt,source},state,currentSeq,events,evidence,nextAfter,capabilities}`, 목록은 `{items:[{id,title,state,category,severity,createdAt,updatedAt}],counts,nextCursor}` 이며 createdAt 내림차순, 같으면 id 내림차순입니다. 제보 오류는 `{error:code,fields?:string[],currentSeq?:integer,state?:string}` 입니다: `bad_input` 400, `forbidden` 403, `not_found` 404, `too_long` 413, `key_reused` 409, `version_conflict` 409, `store_changed` 409, `invalid_transition` 409, 커밋된 이벤트/블롭이 없거나 손상되면 `corrupt_record`, 삭제된 제보는 410입니다. 같은 requestId는 현재 순번/상태 검사보다 먼저 정규 지문으로 비교합니다. 다른 본문은 `key_reused`, 오래된 `expectedSeq` 는 `version_conflict` 입니다.

상태는 `open`(접수), `investigating`(조사 중), `needs-check`(확인 요청), `resolved`(해결), 그리고 끝난 삭제 표석입니다. 분류는 open/investigating을 investigating으로 옮기며 `category:inbox-ui|report-content|other`, `severity:normal|high|low` 를 기록합니다. 수정 확인 요청은 open/investigating/needs-check 에서 허용되고 메모와 수정 증거가 필요하며 `수정안 확인` 이라고 말합니다. 확인은 소유자만 needs-check에서 resolved로, 다시 열기는 소유자만 needs-check/resolved에서 open으로, 삭제는 소유자만 할 수 있습니다. 맞지 않는 짝은 409 `invalid_transition` 입니다. 새 동작마다 이벤트 하나를 쓰고 정확한 재전송은 아무 이벤트도 쓰지 않습니다.

`waiting` 은 부른 세션의 열린 결정 보드 중 소유자 답을 기다리는 것을 나열합니다. 상태가 `mine` 이거나, `theirs` 인데 마지막 의견이 아직 전달되지 않은(delivery `pending`) 보드입니다. 항목은 `{ id, title, url, status, since, seq }` 이고, `since` 는 보드의 마지막 제출, 수정, 의견 이벤트 시각입니다(세션 답장은 바꾸지 않습니다). `seq` 는 `theirs` 일 때 마지막 의견의 seq, 아니면 `null` 입니다. 보고 보드, 소유자 없는 보드, 다른 세션의 보드는 나오지 않고, `session` 이 없으면 `[]` 입니다.

`idle=1` 은 세션이 쉬고 있다고, `idle=0` 은 바쁘다고 서버에 알립니다. 멈춤 감시(알림 참고)는 쉬는 시간만 셉니다. `start=1` 없이 `/api/here` 를 읽으면 살아 있음 표시 말고는 아무 영향이 없습니다.

중복 막기: `dedupeKey` 가 `line:`, `turn:`, `episode:` 로 시작하는 항목 등록은 상태와 상관없이 기존 항목을 `created: false` 로 돌려줍니다. 공지를 비롯한 다른 키는 열린 항목만 맞춥니다.

오류: `not_found` 404, `closed` 409, `duplicate` 409 `{ error, id, url }`, `bad_rev` / `bad_input` 400, `invalid_board` 400(`details` 포함), 권한 없음 403 `{ error: 'forbidden' }`, `/api/open` URL이 30000자를 넘으면 413 `{ error: 'too_long' }`, Aside 실행 파일이 없으면 `/api/open` 은 404 `{ error: "not_installed" }`.

`/api/open` 대상은 `web/targets.json`(ChatGPT, Claude, Claude 앱, Aside, 복사)에서 옵니다. PC 전용 대상은 `open` 권한이 필요합니다. Aside는 `--single-argument` 로 보드 URL을 받고, 나머지는 `rundll32 url.dll,FileProtocolHandler` 로 엽니다.

질문에 대한 답은 질문과 맞춰 봅니다. 비어 있지 않은 의견은 `comment-submitted`, 아니면 질문 하나 이상에 답해야 하고(아니면 400 `question_incomplete`), 라벨은 선택지 라벨과 정확히 같아야 하며 하나만 고르는 질문에는 하나만 됩니다(아니면 400 `invalid_answer`). 60초가 지나도 `delivered` 가 없는 답은 `deliveryUnconfirmed: true` 로 알립니다.

포트를 이미 omo-inbox 서버가 쓰고 있으면 `node src/server.mjs` 는 조용히 0으로 끝나고, 다른 프로그램이면 로그를 남기고 3으로 끝납니다.

## 접근 권한
요청마다 `local`, `pc`, `tailnet`, `reject` 중 하나로 분류합니다.

1. 원격 주소가 루프백이 아니면 reject.
2. `tailscale-funnel-request` 헤더가 있으면 reject.
3. `x-forwarded-for` 가 없을 때 Host가 `127.0.0.1` 또는 `localhost` 면 local, 아니면 reject.
4. 첫 XFF 항목이 `pcTailnetIps` 에 있으면 pc (tailscaled가 자기 PC 트래픽에는 신원 헤더를 빼먹을 수 있어 신원보다 먼저 확인).
5. `tailscale-user-login` 이 없거나 `owner` 와 다르면 reject, 아니면 tailnet.

| 권한 | 허용 |
| --- | --- |
| read, feedback | local, pc, tailnet |
| open | local, pc |
| reopen | local, pc, tailnet |
| session | local |

그래서 tailnet의 휴대폰은 읽고 의견을 보낼 수 있지만, 세션처럼 제출하거나 항목을 올리거나 닫거나 PC에서 프로그램을 띄울 수는 없습니다. 예외는 `POST /api/threads/<sid>/reopen` 이고, 그 대화에 저장된 세션 하나만 다시 엽니다.

제보 경로는 위 ALLOW 표를 바꾸지 않습니다. 전달된 tailnet 제보 요청은 설정된 non-null 소유자도 있어야 하고, local과 알려진 PC는 지금 분류를 그대로 씁니다. 브라우저 변경 요청은 요청의 검증된 local origin 또는 설정된 `publicBase` origin과 같은 `Origin` 헤더가 필요합니다. `Origin` 이 없는 것은 local 비브라우저 CLI와 테스트에만 허용하고, `Origin: null`, 다른 origin, Funnel은 거부합니다. 요청 내용으로는 명령, 폴더, 파일을 고를 수 없고, Funnel은 다른 곳과 마찬가지로 거부합니다.

## 세션 깨우기와 수집
### 수집

확장(`extension/omo-inbox.ts` 와 `extension/inbox/*.ts`)은 루트 대화형 세션에서만 모읍니다. `before_agent_start` 는 등록하지 않습니다.

- 질문: `ask-user:asked` 가 `question` 항목을 만들고, `ask-user:closed` 가 `answered-phone`, `answered-terminal`, `timed-out`, `cancelled` 로 닫습니다.
- 권한: 실행 중에 뜬 `Permission required:` 선택이 `permission` 항목을 만듭니다.
- 에피소드: 열린 에피소드가 없을 때의 에이전트 시작이 하나를 엽니다. 열린 동안의 에이전트 시작은 모두 그 에피소드를 늘립니다(작업 깨우기, goal 이어가기, 폰 답장, 답, 보드 의견, 터미널 입력). 소유자가 일으킨 시작은 끼어들기 수만 늘립니다. 마지막 메시지 뒤의 다음 시작은 새 에피소드를 엽니다.
- 줄: 글이 있는 어시스턴트 메시지마다 `progress` 줄을 보냅니다. 중복 키 `line:<sid>:m<메시지 시각>`, 원문 8192자까지.
- 다시 깨어날지: 턴 끝에서 질문이나 대화 상자가 열려 있거나, `omo-inbox` 가 아닌 깨우기 출처가 세어지거나, 모니터가 돌거나, 보류가 걸려 있거나(자기 `omo-inbox` 보류도 셈), 이어가기가 예약돼 있거나(`goal_continuation_timer_state` `armed`), 복원된 지 60초가 안 됐으면 세션이 다시 깨어납니다. 터미널 백그라운드 세션과 모니터는 에피소드가 열린 뒤 시작했고 persistent나 paused가 아닐 때만 셉니다. 깨우기 수는 수준 상태라 턴 끝과 reload를 지나도 남습니다.
- 닫기: 다시 깨어날 턴 끝은 줄만 더합니다. 아니면 에피소드가 닫히고 이 순서로 봅니다. 내가 멈춤 -> 조용한 `turn`, 이번 실행에서 goal 막힘 -> `blocked`(실행 전부터 막혀 있던 goal은 이후 작업을 닫지 않음), goal 끝남(이 에피소드의 `update_goal` 완료 포함) -> `done`, goal이 아직 활성 -> 멈춘 것으로 표시한 `turn`, 나머지 -> 나를 기다리는 `turn`. 마지막 메시지의 중복 키는 `episode:<sid>:<여는 시각>:<닫힌 이유>:m<마지막 시각>`, 원문은 `{final, request, lastRequest, goal?}`.
- 뒤집기: 에피소드가 열린 채 쉬는 동안 깨어날 이유를 없애는 신호가 오면 10초 타이머를 겁니다. 타이머가 울릴 때도 쉬고 있고 깨울 것이 없으면 에피소드를 닫습니다(활성 goal이면 멈춤).
- goal: 에피소드 안의 `update_goal` blocked나 complete는 턴 끝에 에피소드를 닫습니다(닫기 대기). 에피소드 밖이거나 goal 파일이 바뀌면 예전처럼 `blocked` 나 `done` 을 만듭니다.
- 다시 열기: 줄이 아직 없는 에피소드를 연 시작인데 세션의 가장 최근 에피소드 항목이 멈춘 마지막 메시지이거나 아직 푸시하지 않은 마지막 메시지이면, 서버가 새로 시작하지 않고 같은 키로 그 에피소드를 이어 갑니다.
- 소유자 원인: 폰 전달, 질문 답, 보드 의견은 다음 에이전트 시작을 한 번, 30분까지 소유자 원인으로 표시합니다. 터미널 입력도 소유자 원인입니다. 나머지 시작은 `system` 입니다.
- 복원: 세션이 시작할 때마다(시작, 이어 열기, reload) 확장이 대화의 `meta.episode` 가 있는 가장 최근 항목을 읽어 마지막 메시지가 없는 에피소드를 이어 가고, 60초 동안은 깨어날 것으로 칩니다.
- 기록: 판정마다 `extension.log` 에 `capture: <verdict> <reasons>` 를 남깁니다.
- 턴 항목의 중복 키는 `turn:<sid>:m<마지막 어시스턴트 답의 보낸 시각>` 이라 확장 사본이 바뀌어도 같습니다. 2.5초 대기 안에 `/reload` 가 오면 예전 사본의 분류가 사라지므로, reload 로 시작한 새 사본이 세션 기록을 읽어 끝난 어시스턴트 답으로 끝나 있고 그 뒤 대화에 항목이 없으면 그 답을 한 번 분류합니다.
- 활동: 터미널 입력과 에이전트 시작을 `cause` 와 함께 보내고, 이것이 지난 턴 항목을 닫습니다.
- 대화 정보(cwd, 세션 파일, 세션 이름, 첫 요청과 마지막 요청, 모델)는 처음 보낼 때와 세션 시작 때 보냅니다.
- 프롬프트 캐시: 어시스턴트 메시지가 시작될 때마다 모델의 캐시 수명으로 따뜻한 시각을 옮기고, 30초 넘게 움직이면 보냅니다.

### 답 전달

- 질문 다리가 세션의 질문 화면을 감쌉니다. 폰 답은 기다리는 질문을 풀고 터미널 화면을 닫습니다. 터미널 답이 먼저 오면 그쪽이 이깁니다. `/reload` 뒤에는 기다림이 사라지므로 항목에 `리로드 후에는 터미널에서 답해 주세요` 가 나옵니다. 이 연결점이 없는 런타임은 터미널 전용(`터미널에서 답해 주세요`)이 됩니다.
- 닫힌 질문에 늦게 온 폰 답은 다른 곳에서 답했으면 버리고, 아니면 `[omo-inbox] 폰에서 늦게 온 답 (질문 "<header>"): <answer>` 로 한 번 보냅니다.
- 권한 답은 `Allow once`, `Deny`, `Deny with feedback` 로 바뀝니다(의견 글은 이어지는 의견 입력에 답함). 닫힌 대화 상자는 `refused` 로 확인합니다.
- 3초마다, 그리고 상태를 갱신할 때마다 확장은 `<home>/mailbox/<session>/` 을 비우고, 각 전달 id를 먼저 `<home>/ledger/` 에 기록한 뒤 `/api/items/<itemId>/delivered` 로 확인합니다. turn, blocked, done, notice 항목에 대한 답장과 자유 메시지는 세션이 쉬고 있으면 후속 메시지로, 실행 중이면 현재 턴 epoch와 함께 steer로 넣습니다(`admitExternalMessage`, 없으면 `sendUserMessage`). `turn_conflict` 나 보류된 초안은 파일을 다음 주기로 넘깁니다. 질문 답은 steer로 넣지 않습니다. 원장에 이미 있는 전달 id는 파일을 지우기 전에 기록된 how로 다시 확인합니다. `explain` 은 요약을 더 쉬운 말로 다시 만듭니다.
- 다시 열기. `POST /api/threads/<sid>/reopen` 은 꺼진 세션을 다시 엽니다. 명령은 PC에서 thread.json으로 만든 정해진 실행 명령뿐입니다. 대상은 저장된 `sessionFile` 이 안전한 경로이고 있는 `.jsonl` 이면 그 파일, 아니면 sid입니다. 세션 폴더는 안전한 절대 경로이고 실제로 있어야 합니다. `orca.exe worktree list --json` 이 그 폴더를 나열하면 Orca 터미널 탭을 엽니다(`orca.exe terminal create --worktree path:<folder> --title <title> --command 'omo --session "<target>"' --focus --json`). 아니거나 Orca가 오류로 끝나면 Windows Terminal 창을 엽니다(`wt.exe -w -1 new-tab -d <folder> --title <title> <omo> --session <target>`). Orca가 시간 안에 답하지 않거나 알아볼 수 없는 답을 주면 Windows Terminal로 넘어가지 않고 멈춥니다(`launch_failed`). Orca가 이미 탭을 열었을 수 있기 때문입니다. 프로세스는 인자 목록으로 띄우고 셸은 쓰지 않습니다. 같은 세션을 60초 안에 다시 열면 아무것도 띄우지 않고 `already: true` 로 답합니다. 답장은 우편함에 남았다가 세션이 붙으면 전달됩니다. `INBOX_REOPEN_SINK=<file>` 은 띄우는 대신 계획한 시도를 JSON 한 줄로 씁니다(테스트와 QA).

### 보드 깨우기

시각 보드에 대해서는 확장이 omo-desk의 동작을 그대로 지킵니다. 하위 세션이나 task member 세션에서는 아무것도 하지 않습니다. 일반 세션에서는:

- 3초마다 `<home>/mailbox/<session>/*.json` 의 보드 의견을 읽습니다. 기획안이 아직 `theirs` 이거나 서버에 닿지 않으면 문구를 턴을 시작하는 후속 메시지로 전달하고 파일을 지웁니다. 메모리의 집합이 중복 전달을 막습니다.
- 30초마다, 세션 시작 때, 전달 직후에 `/api/here` 를 부릅니다. 하단 표시줄에 `🙋 {mine} 🤖 {theirs}` 가 나오고, 0인 쪽은 뺍니다. 서버가 꺼져 있으면 `Inbox 서버 꺼짐` 을 보이고 120초에 한 번까지 `inbox server start` 를 실행합니다.
- 알림: 이 워크트리에서 기다리는 의견 중 소유 세션이 살아 있지 않은 것(90초 동안 `/api/here` 호출 없음, 종료, 하위 세션, id 없음)은 세션마다 한 번 알립니다. 재개된 세션은 시작할 때 자기에게 온 답 안 한 의견을 다시 안내받습니다.
- 종료 때 `/api/bye` 를 불러 소유자가 바로 떠난 것으로 셉니다. 종료 이유가 `reload` 가 아니면 `closed: true` 를 함께 보냅니다. 그냥 bye(`/reload`)는 세션을 90초 동안 살아 있는 것으로 둡니다. 서버는 세션마다 마지막 `/api/here` 시각을 `<home>/data/live.json` 에 두고, 시작할 때 90초가 안 된 것을 되살립니다. 확장은 30초마다 `/api/here` 를 부르니, 살아 있는 대화가 끝남이나 `세션 꺼짐` 으로 깜빡이지 않습니다.
- 기다리는 보드: `/api/here` 갱신이 성공할 때마다 답 시간 안의 `waiting` 보드를 senpi에 깨우기 출처 `omo-inbox` 로 알리고(`wake_source_state` `{ source: "omo-inbox", activeCount }`, 보류보다 먼저 보냄) goal 이어가기를 보류합니다(`continuation_hold_state` `{ source: "omo-inbox", active }`). 이게 없으면 goal이 바로 다시 재촉하고, 에이전트는 보드를 질문 도구로 한 번 더 묻는데 보드 답으로는 그 질문이 풀리지 않습니다. senpi는 `source`/`activeCount` 와 `active` 만 읽습니다.
- 해제(보류 false, 그다음 개수 0)는 남은 보드가 없을 때와 종료 때 일어납니다. 서버에 닿지 않는 동안에는 마지막으로 받은 waiting 목록을 매 주기 로컬 시계로 다시 따집니다. 답 시간 안의 보드는 계속 세고, 지난 보드는 해제합니다.
- 답 시간은 senpi의 `askUser.timeoutMinutes`(기본 30)이고 1-120분으로 제한합니다. `since`, 곧 보드의 마지막 제출, 수정, 의견 이벤트부터 재며 세션 답장은 치지 않습니다. 질문 도구의 유휴 타이머와 달리 페이지를 봐도 다시 시작하지 않습니다. 읽을 수 없는 `since` 는 지난 것으로 칩니다. 상태가 `theirs` 인 보드는 항상 셉니다.
- 도구 실행이 끝날 때마다 갱신도 합니다(한 번에 하나, 진행 중에 요청이 오면 한 번 더). 그래서 턴 중에 제출한 보드도 턴이 끝나기 전에 셉니다.
- 무응답: `mine` 보드가 답 시간을 넘기면 세지 않고, 세션은 턴을 시작하는 후속 메시지 `[omo-inbox] 답이 없습니다: <title> (<id>), <n>분` 을 보드와 마지막 이벤트 시각마다 한 번 받습니다. 세션 시작이나 reload 때 이미 답 시간이 지난 보드는 알리지 않습니다.
- 보드를 세는 동안 senpi는 이를 백그라운드 작업으로 보므로 그 턴의 Stop hook은 답 턴까지 미뤄집니다(소유자에게는 omo-inbox 푸시 알림이 알립니다). 보류 중에는 senpi가 goal 카운트다운을 보이지 않고, 하단 `🙋 N` 이 표시입니다. 하위 세션과 senpi가 아닌 세션은 보류도 알림도 받지 않습니다.
- `/reload` 뒤에는 교체된 예전 확장 사본이 senpi가 자기 세대를 stale로 처음 알릴 때 타이머를 멈추므로, 지금 사본만 폴링하고 세션을 깨웁니다.

세션 id는 `INBOX_SESSION` 또는 `PI_SESSION_ID` 에서 옵니다. 보드 종류 때문에 확장이 바뀌지는 않습니다. 의견을 단 보고 확인을 포함해 `theirs` 보드는 이미 전달합니다.

두 경로는 다릅니다. 우편함 후속 메시지는 자동이라 소유 세션에서 턴을 시작합니다. 대기 알림(`inbox pending`, `/api/here`)은 수동이라 의견이 기다린다고 알리기만 하므로, 소유자 없는 보드는 보이지만 턴으로 전달되지는 않습니다.

## 다음 행동
서버는 나를 기다리는 마지막 메시지(`turn`, `done`, `blocked`, 멈춤 마지막 메시지 포함)마다 판정을 계산합니다. 메시지가 올 때, 모델 요약이 올 때, 제공자 목록이 바뀔 때, 그리고 저장된 판정이 30초보다 오래된 대화를 열 때 다시 계산합니다. 서버 시작 때는 이 업데이트 전에 저장된 마지막 메시지도 채웁니다. 진행 항목은 판정이 없습니다.

- 형태: `{v: 1, state, reason, actions, warnings, facts: {git, plan, watch}, source: "heuristic"|"model", at}`.
- 우선순위: `blocked`(종류 blocked) -> `stalled`(멈춤 마지막 메시지) -> `ask`(마무리나 계획 질문이 아닌 물음) -> `plan`(열린 계획을 찾음) -> `ship`(커밋이나 푸시가 안 된 git, 본문의 마무리 표시, 마무리 물음, 모델의 `ship` 힌트) -> `done`.
- 이유: done `남은 일이 없습니다`, plan `계획 <slug> 실행 대기`, ship `커밋 안 된 변경 N개 · 푸시 안 된 커밋 N개`(해당하는 부분만) 또는 `마무리 작업이 남았습니다`, ask `답을 기다립니다`, blocked `막힌 목표를 풀어야 합니다`, stalled `멈춘 작업을 이어가야 합니다`.
- 감지는 마지막 메시지의 끝 1500자를 읽습니다(마지막 메시지에 계획 slug가 없으면 같은 작업 구간의 마지막 세 줄에서도 찾습니다. 다음 단계를 말한 뒤 짧은 보고로 끝내는 경우가 많기 때문입니다): 계획 slug(`/skill:ulw-execute`, `/ulw-execute`, `$ulw-execute` 뒤의 slug), 남은 일 없음 줄(`Next: 없음`, `남은 작업 없음`, `할 일이 없습니다`), 마무리 표시(커밋 안 함, 푸시 안 함, 설치 안 함, `/reload` 필요).
- git 사실: worktree(없으면 cwd)에서 `git status --porcelain=v1 --branch`(`git -C <dir>`), 셸 없음, 제한 3초. 저장소가 아닌 폴더는 `git: null`, 그 밖의 실패나 시간 초과는 `{unknown: true}` 이고 경고 `git 상태를 확인하지 못했습니다` 가 붙으며 git 행동은 없습니다.
- 계획 찾기: 마지막 메시지 끝의 slug를 `.omo/plans/<slug>.md` 로 worktree, cwd, 메인 체크아웃 순서로 찾습니다. `root` 는 `.omo/plans` 를 담은 폴더입니다. 체크하지 않은 `- [ ]` 줄이 남아 있으면 열린 계획입니다. 그 계획을 직접 실행하는 세션(`executes`, 또는 인계받은 slug)에는 계획 제안이 없습니다.
- 모델 힌트: 모델 요약은 `next` 를 담을 수 있습니다(요약 참고). 요약이 모델에서 왔을 때만 씁니다.
- 경고 순서: `커밋 안 된 변경 N개`, `푸시 안 된 커밋 N개`, `상시 감시 N개가 함께 꺼집니다`, `git 상태를 확인하지 못했습니다`.
- 행동(최대 5개, 주 행동은 많아야 하나이고 맨 앞):

| id | kind | label | prompt | 언제 |
| --- | --- | --- | --- | --- |
| `close` | close | `세션 닫기` | - | 모든 상태, done의 주 행동 |
| `new-session` | new-session | `새 세션에서 실행` | `/skill:ulw-execute <slug>` | plan, 주 행동 |
| `commit-push` | continue | `커밋·푸시` | `변경을 커밋하고 푸시해` | 커밋 안 된 변경이 있는 ship, 주 행동 |
| `push` | continue | `푸시` | `커밋을 푸시해` | 푸시 안 된 커밋만 있는 ship, 주 행동 |
| `m1`, `m2` | continue | 모델 label(12자) | 모델 prompt(200자) | done, ship |
| `p:<producer>:<key>` | continue 또는 run | 제공자 label | 제공자 prompt | done, ship, ask, blocked, stalled. run은 살아 있을 때만 |

- 종료된 세션. 대화의 가장 최근 needs-you 마지막 메시지가 `session-closed` 로 닫혔고 더 새 needs-you 항목도 인계도 없으면 행동 가능한 닫힌 마지막 메시지입니다. 그 판정은 close와 run 행동을 빼고 계산하므로 계획 행동과 이어가기 행동만 남습니다. 이어가기는 세션을 다시 열 때까지 우편함에 남습니다.
- 누를 때 재확인: close, commit-push, push, new-session 전에 서버가 git과 계획을 다시 살핍니다. 계획 파일이 사라진 new-session은 `plan_missing`, 그 밖에 사라진 행동은 새 판정과 함께 `stale`, 새 경고가 있는 close는 `confirm: true` 가 필요하고 없으면 경고와 함께 `confirm_required` 입니다.
- 전달: 이어가기는 답장처럼 우편함으로 갑니다. 살아 있는 세션의 close와 run은 `<home>/control/<sid>/<deliveryId>.json` `{v: 1, type: "session-control", action, itemId, deliveryId, issuedAt, producer?, key?}` 를 씁니다. 확장은 우편함 다음에 이것을 읽고 delivery id를 장부에 남긴 뒤 `control` 로 확인합니다. 항목이 닫힌 제어는 `dropped` `item closed`, 10분보다 오래된 제어는 `dropped` `stale` 로 확인합니다. close는 `ctx.shutdown()` 을 부르고 bye가 항목을 `closed-by-owner` 로 닫습니다. 꺼진 세션의 close는 바로 닫습니다. run은 `inbox:action` 을 냅니다(다른 확장의 행동 참고).
- 상시 감시: 확장은 마지막 메시지마다 영구적이고 멈추지 않은 감시 수를 세고(`meta.watch`), `/api/here?watch=<n>` 마다 현재 수를 보냅니다. 닫기 경고는 현재 수를 씁니다.
- 새 세션: new-session은 계획 root에서 `omo --session-id <uuidv7> "/skill:ulw-execute <slug>"` 를 띄웁니다. Orca가 그 폴더를 알면 Orca 탭, 아니면 Windows Terminal로, 다시 열기와 같은 방식입니다. 새 세션이 처음 `/api/here` 를 부르면 인계가 `connected` 가 되고 옛 세션은 `handed-off` 로 닫힙니다(살아 있으면 제어 파일, 꺼져 있으면 바로).
- Orca 탭: 세션이 Orca에서 돌면(`ORCA_TERMINAL_HANDLE` 있음) close가 `bin/close-tab.mjs` 를 띄우고, 이것이 omo 종료를 기다린 뒤 `orca terminal close --tab` 을 실행합니다. `config.json` `next.closeTab: false` 면 하지 않습니다.
- 배포: 이 업데이트 전에 시작한 세션은 제어 파일을 읽지 않습니다. 닫기가 되려면 그 세션에서 `/reload` 를 하세요.

## 요약
요약 요청은 서버가 만들고 결과도 서버가 검사합니다. 확장은 모델만 돌립니다.

- 모델: `config.json` 의 `summary.models`, 기본은 `anthropic-subscription/claude-sonnet-5`, 그다음 `chatgpt-subscription/gpt-6-luna-fast`, 그다음 `anthropic-subscription/claude-haiku-4-5`. 설정되고 인증된 첫 모델을 60초 제한으로 씁니다. 첫 모델이 30초 안에 답하지 않으면 다음 모델을 시작하고, 먼저 온 쓸 만한 답을 씁니다. 세션 자신의 모델은 쓰지 않습니다. `summary.enabled: false` 면 휴리스틱 요약만 씁니다.
- 대체: 모델 요약이 오기 전, 또는 모델이 실패하거나 잘못된 것을 내면 휴리스틱 요약을 보입니다. 인계 블록의 `For you` 줄이나 첫 줄이 제목, `요청: <첫 요청>` 이 하던 일, 경로와 코드를 뺀 글이 본문, 마지막 질문 문장이 묻는 것(질문이 없으면 `직접 실행해야 해요` 처럼 내가 할 일을 말한 마지막 문장), 항목 종류에서 나온 무응답 줄.
- 모양: 제목 40자, 하던 일 120자, 본문 300자, 묻는 것 120자, 이유 달린 선택지 4개까지, 무응답 줄, 설명한 용어 3개까지, 대화에 제목이 없을 때 대화 제목(24자). 권장안은 원문에 있을 때만 나오고, 프롬프트가 지어내지 못하게 막습니다.
- 묻는 것과 용어: `ask` 에는 나에게 하는 물음이나, 원문이 내가 직접 해야 한다고 한 일(실행, 설치, 확인, 창 닫기, 새 세션 시작)을 씁니다. 둘 다 없을 때만 null입니다. 용어는 제목, 하던 일, 본문, 묻는 것 중 한 곳에 그대로 나오는 낱말이어야 하고, 아니면 버립니다. 보드를 기다리는 라벨은 `Review 답`, needs-you를 닫는 라벨은 `내 차례` 입니다.
- 점검과 수정: 서버는 모델 요약을 자르기 전에 점검합니다. 아는 말 목록 밖의 코드나 영문 같은 말, 길이를 넘은 칸, 과정만 말하는 제목, 원문 끝 질문을 빠뜨린 요약, 원문 끝의 할 일을 비운 ask, 원문이 권하는 안을 빠뜨린 질문 요약을 찾습니다. 하나라도 있으면 자른 초안을 저장하고, 문제를 적어 확장에 한 번만 고쳐 쓰기를 요청합니다. 고친 요약은 다시 점검하지 않고 저장합니다.
- 무응답 줄: 모델이 쓰지 않습니다. 서버가 실행 사실로 정합니다. 꼭 답해야 하는 질문은 기다리고(`답이 없으면 그 작업은 하지 않고 기다립니다`), 선택 질문은 시간이 지나면 에이전트가 스스로 판단해 진행하고, 나중에 답하는 질문(`waitForAnswer: false`)은 에이전트가 일을 계속한다고 적고, 권한 요청은 기다리고, 기다리는 턴은 세션이 기다린다고(멈춘 goal이면 goal이 멈춰 있다고) 적고, 막힌 goal은 멈춘 채로 있다고 적습니다. 보고, 진행, 알림, 보드에는 무응답 줄이 없습니다.
- 질문 도구 항목의 권장안: 선택지에 권장 표시(`권장`, `추천`, `Recommended`)가 있는데 요약이 그 선택지를 말하지 않으면, 서버가 본문 앞에 `권장: <선택지>` 를 붙입니다.
- `더 쉽게` 는 같은 요약을 더 쉬운 말로 다시 청합니다.
- 줄: 진행 줄은 바로 휴리스틱 제목을 받고(인계 블록의 `Now:` 칸, 없으면 안내 문장 뒤 첫 문장, 없으면 첫 줄, 40자까지. 영어면 `대기: <label>` 이나 `진행 중`), 그 뒤 40자 이하의 한국어 모델 한 줄이 그 자리를 바꿉니다. `progress.modelLines: false` 면 모델을 부르지 않습니다. 줄 요청은 나를 기다리는 요약을 늦추지 않고, 기다리는 줄 중 가장 최근 3개만 모델을 부릅니다.
- 다음 힌트: turn, done, blocked 항목에는 모델이 `next: {state: "done"|"ship"|"ask", actions: [{label(12자), prompt(200자)}]}` 또는 null을 더할 수 있습니다. actions는 마지막 메시지가 직접 말한 후속 작업(설치, 리로드, 테스트 서버, 배포, 확인)만, 최대 2개입니다.
- 에피소드 마지막 메시지: 요청에 구간(`이번 작업 구간`: 메시지 수, 시각, 끝난 이유, 질문, 끼어들기), 여는 요청, 줄마다 시각과 한 줄(최근 30개), 마지막 메시지(앞 3000, 뒤 1500)를 넣고 8000자를 넘지 않습니다. 결론은 마지막 메시지의 결과이고, 기다리는 줄은 결과가 아닙니다. 멈춤 문구는 정말 멈췄을 때만 씁니다.
- 맥락: 세션 폴더는 제품이 아니라 `세션 폴더` 로 적고, 요약은 에피소드가 실제로 작업한 제품을 말합니다.
- 개인 정보: 요청에 넣는 글은 모두 먼저 `src/redact.mjs` 를 거칩니다(토큰, 키 같은 비밀을 가림). 긴 글은 앞 4000자와 뒤 2000자로 자릅니다. 요약은 이 PC에 남습니다.

## 알림
푸시는 항목 종류와 정책을 따릅니다. 푸시는 보류 시간만큼 기다렸다가, 그 사이 항목이 닫히거나 답을 받았거나 항목이 생긴 뒤 활동이 있으면(터미널에 있음) 취소합니다.

| 종류 / 정책 | 푸시 | 보류 | 버튼 (최대 2) |
| --- | --- | --- | --- |
| question, 필수 아님 | 예 | 15초 | 권장 선택지가 있으면 `권장: <label>`, 그다음 열기 |
| question, 필수 | 예 | 15초 | 열기 |
| permission | 예 | 15초 | 열기 |
| turn | 예 | 30초 | 열기 |
| blocked | 예 | 30초 | 열기 |
| done | 예 | 30초 | next가 경고 없는 done이면 `세션 닫기`, 그다음 열기 |
| progress | 아니오 | - | - |
| board (primary) | 예 | 0 | 열기(새 기획안, 수정안, 답장) |
| notice now / soon | 예 | 0 | 열기 |
| notice fyi | 아니오 | - | - |
| 캐시 알림 | 예 | 캐시가 식기 `config.json` 의 `cacheLeadMinutes`분 전(기본 5) | 열기 |

- 제목은 `🙋 <대화 제목>`, 본문은 제목과 묻는 것을 가려서(redact) 120자까지. 누르면 `/s/<sid>#<itemId>` 가 열립니다. 같은 대화의 알림은 서로 바꿔 씁니다(`tag: s-<sid>`).
- 캐시 알림: `🔥 캐시가 <n>분 뒤 식습니다`. 항목과 따뜻한 시각마다 한 번, 대화에 활성 goal이 없고 항목이 열려 있을 때만.
- 서버를 다시 시작하면 열린 항목으로 일정을 다시 짭니다. 지난 보류는 60분이 안 된 항목이면 바로 보냅니다.
- 에피소드: 줄은 푸시하지 않습니다. 마지막 메시지만 평소의 30초 보류로 푸시하니, 요청 하나에 푸시 하나입니다.
- 멈춤 감시: 열린 에피소드의 세션이 마지막 줄 뒤 `episode.stallMinutes`(기본 60, 5-240으로 맞춤) 동안 쉬면 줄들로 만든 멈춤 마지막 메시지 하나를 푸시합니다. 세션이 없어졌으면 아무것도 보내지 않습니다. 바쁨 보고가 오면 멈추고, 서버를 다시 시작하면 다시 짭니다. `INBOX_EPISODE_STALL_MS` 가 밀리초로 덮어씁니다(테스트).
- 걸린 푸시는 소유자 활동만 취소합니다. 시스템 시작(goal 이어가기, 작업 깨우기)은 항목을 넘기지만 푸시를 취소하지 않습니다.
- 숨긴 대화는 항목 푸시도 캐시 푸시도 보내지 않습니다. 숨긴 동안 온 항목, 숨길 때 아직 기다리던 항목은 처리됨(`pushedAt`)으로 표시하고, 숨김 해제나 서버 재시작 뒤에도 나중에 보내지 않습니다. Review 알림은 그대로입니다.
- `INBOX_PUSH_SINK=<file>` 은 보낼 푸시를 보내지 않고 JSON 한 줄로 덧붙입니다(테스트와 QA).

### 보드 알림

나에게 뭔가 오면 Inbox가 닫혀 있어도 브라우저에 알림이 뜹니다. 알림을 누르면 그 기획안(`/p/<id>`)이 열립니다.

| 계기 | 제목 | 본문 |
| --- | --- | --- |
| 새 기획안(`existing` 재제출은 제외) | `새 Review · <title>` | `<제품> · <브랜치>` |
| `inbox revise` | `수정본 <rev> · <title>` | 수정 메모, 없으면 `<제품> · <브랜치>` |
| `inbox reply` | `답이 왔습니다 · <title>` | 답 문구를 120자까지 |

내가 보낸 의견과 `inbox close` 는 알리지 않습니다. 푸시는 HTTP 응답을 보낸 뒤에 보내므로 응답을 늦추지 않고, 보내기에 실패하면 `logs/server.log` 에 남깁니다.

Inbox 머리글에서 브라우저마다 한 번 켭니다. `알림 받기` 는 권한을 묻고, `/sw.js` 를 등록하고, 브라우저의 푸시 서비스로 구독한 뒤 구독 정보를 `/api/push/subscribe` 로 보냅니다(PC 페이지와 tailnet 페이지 모두 가능. Funnel은 다른 곳과 마찬가지로 거부). 서버는 본문이 `새 Review와 답이 오면 알려 드립니다` 인 환영 푸시로 답합니다. `알림 켜짐` 을 누르면 다시 꺼지고, `알림 막힘` 은 브라우저가 권한을 막았다는 뜻입니다. 페이지가 보안 컨텍스트가 아니거나(tailnet `https` 페이지와 `127.0.0.1` 은 맞고, 평범한 `http://<ip>` 페이지는 아님) 브라우저가 푸시를 지원하지 않으면 버튼이 숨겨집니다.

`<home>/push/` 에 저장합니다: `vapid.json`(서버의 P-256 키 쌍. 처음 쓸 때 만들고 임시 파일에 쓴 뒤 이름을 바꿈)과 `subscriptions.json`(endpoint당 한 항목: `endpoint`, `keys`, `created`, `ua`, `via`). 둘 다 비밀이며 이 PC에만 있습니다. 보내기는 구독의 endpoint로 `TTL: 86400`, `Urgency: high`, VAPID `Authorization` 헤더(ES256 JWT, 12시간), RFC 8291 `aes128gcm` 본문을 담아 POST하는 것입니다. 201/202면 전달, 404/410이면 구독을 지우고, 그 밖은 로그를 남기고 구독을 둡니다.

한계:

- 내용(제목, 본문, `/p/<id>`)은 브라우저까지 종단 간 암호화되어, 푸시 서비스(Google, Mozilla, Apple)는 무언가 보냈다는 사실만 봅니다.
- PC가 켜져 있고 서버가 돌고 있어야 합니다. 서버가 꺼져 있으면 쌓아 두지 않습니다.
- Android(삼성 인터넷): 탭과 브라우저를 닫아도 옵니다. 단 브라우저 앱을 강제 종료했거나 배터리 제한을 걸었다면 오지 않습니다.
- PC: 브라우저 프로그램이 실행 중이어야 합니다(백그라운드 프로세스면 충분하고 탭은 닫아도 됩니다).
- 브라우저마다, origin마다(PC의 `http://127.0.0.1:4387`, 휴대폰의 tailnet `https` origin) 따로 구독합니다.

### 제보 알림

새 `request_check` 이벤트만 기존 구독으로 푸시합니다: 제목 `제보한 문제의 수정안이 왔습니다`, 본문 `제보함에서 확인해 주세요.`, URL `/issues/<id>`, tag `issue:<id>`. 설명, 그림, 로그 글은 싣지 않습니다. 정확한 재전송은 두 번째 푸시를 보내지 않고, 푸시 실패가 제보를 되돌리거나 전달됐다고 주장하지 않습니다. 푸시를 쓸 수 없을 때는 배지와 목록이 기준입니다. 원래 대화 이벤트나 우편함에는 쓰지 않습니다.

## 다른 확장의 공지
다른 확장은 `pi.events` 에 `inbox:notice` 를 보내 Inbox에 글을 올릴 수 있습니다. 확장이 세션과 cwd를 채워 `POST /api/notices` 로 넘깁니다. 셸에서는 `inbox notify` 가 같은 일을 합니다.

모양(v1): `{v: 1, producer, dedupeKey, title, body?, urgency, session?, cwd?, expiresAt?, url?, actions?}`.

- `producer` 는 `^[a-z0-9-]{1,40}$`, `dedupeKey` 는 `^[A-Za-z0-9._:-]{1,80}$`, `title` 1-80자, `body` 500자까지.
- `urgency` 는 `now`, `soon`(푸시, 나를 기다림), `fyi`(푸시 없음).
- `expiresAt` 은 ISO이고, 지난 공지는 `expired` 로 닫힌 것으로 읽습니다. `url` 은 상대 경로나 https. `actions` 는 `["ack", "open-url"]` 의 부분집합.
- producer와 dedupe 키가 같은 새 공지는 앞의 열린 공지를 `superseded` 로 닫습니다. 세션 없는 공지는 `알림` 대화로 갑니다.
- 오류는 400이고 문제마다 `details` 한 줄입니다.

예: keepwarm 확장이 캐시가 식는다고 알리기.

```ts
pi.events.emit("inbox:notice", {
	v: 1,
	producer: "keepwarm",
	dedupeKey: "cache-cooling",
	title: "캐시가 곧 식습니다",
	body: "5분 안에 이어 가지 않으면 다음 요청이 느려집니다",
	urgency: "soon",
});
```

```powershell
node "<home>/app/bin/inbox.mjs" notify --producer keepwarm --key cache-cooling --title "캐시가 곧 식습니다" --urgency soon
```

## 다른 확장의 행동
다른 확장은 `pi.events` 에 `inbox:actions` 를 내서 세션의 마지막 메시지에 버튼을 더할 수 있습니다. 확장이 목록을 검사해 `POST /api/threads/<sid>/actions` 로 보내고, 다시 연결되면 또 보냅니다.

형태(v1): `{v: 1, producer, actions: [{key, label, prompt?, run?}]}`.

- `producer` 는 `^[a-z0-9-]{1,40}$`, 행동 0개에서 4개, `key` 는 `^[A-Za-z0-9._:-]{1,40}$`, `label` 1자에서 12자, `prompt`(1자에서 300자)와 `run: true` 중 정확히 하나.
- producer마다 가장 최근 목록이 이깁니다. 빈 목록은 그 producer를 지웁니다. 행동은 기본 행동 뒤에 `p:<producer>:<key>` 로 나옵니다.
- `prompt` 행동은 답장처럼 세션에 갑니다. `run` 행동은 세션이 살아 있을 때만 보이고, 누르면 제어 파일을 쓰고 확장이 그 세션에서 `inbox:action` `{v: 1, producer, key, itemId, session}` 을 냅니다.

예: 미리보기를 열어 주는 확장:

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
- 포트 4388만 씁니다: `tailscale serve --bg --https=4388 http://127.0.0.1:4387`.
- Funnel은 절대 쓰지 않습니다. 서버도 Funnel 요청을 거부합니다.
- 443은 건드리지 않습니다. 설치는 먼저 `serve status --json` 을 저장하고, 4388을 추가한 뒤 443 Web 항목, AllowFunnel, TCP 443이 그대로인지 확인합니다. 하나라도 다르면 4388을 다시 끄고 `failed:443-guard` 를 보고합니다. 기준값은 `doctor` 용으로 `baseline443` 에 저장합니다.
- 외부 URL은 `https://<machine>.<tailnet>.ts.net:4388/p/<id>` 꼴입니다.
- Orca 모바일 앱은 누른 화면 줄의 글자만 링크로 읽어서, 줄바꿈된 URL은 뒷부분(`:4388/...`)이 잘립니다. 터미널 하이퍼링크로 나가야 통째로 열립니다. `~/.omo/agent/settings.json` 에 `"terminal": { "hyperlinks": true }` 를 넣고(senpi는 Windows의 Orca에서 하이퍼링크를 꺼 둡니다), URL은 백틱 없이 그대로 출력합니다.

## 테스트
```
node --test "test/**/*.test.mjs"
```

테스트는 임시 home, 포트 0, `reg`·`tailscale`·`wscript` 가짜 실행기, 짧은 확인 간격을 씁니다. 실제 시간을 기다리지 않고, 실제 home, agent 폴더, tailscale도 건드리지 않습니다.

기획안 페이지 브라우저 QA(Bun 1.4 이상과 Chrome 필요, `node --test` 에는 들어가지 않음): `bun qa/send-qa.mjs`, `bun qa/viewer-qa.mjs`, `bun qa/read-aloud-qa.mjs`. 각각 임시 home에서 `src/server.mjs` 를 띄우고(포트 4391, 4392, 4393) 휴대폰·데스크톱 너비로 헤드리스 Chrome을 움직인 뒤 `N/N checks passed` 로 끝나고, 스크린샷은 출력한 임시 폴더에 남깁니다.

Inbox 차례 흐름 브라우저 QA: `bun qa/turn-list-qa.mjs`(포트 4395), `bun qa/turn-thread-qa.mjs`(4396), `bun qa/turn-bubble-qa.mjs`(4397)도 같은 방식입니다. `bun qa/reopen-launch-qa.mjs` 는 실제 실행기를 씁니다. 진짜 Orca 터미널과 Windows Terminal 창을 열었다 닫습니다.

다음 행동 브라우저 QA: `bun qa/next-qa.mjs`(포트 4402)도 같은 방식입니다. `bun qa/session-qa.mjs` 의 S25, S26은 실제 세션으로 닫기와 새 세션을 확인하고, `reopen-launch-qa` 는 닫기가 Orca 탭을 닫는지도 확인합니다.

테스트와 QA의 푸시는 모두 `INBOX_PUSH_SINK` 파일로, 다시 열기는 모두 `INBOX_REOPEN_SINK` 파일로 갑니다(`reopen-launch-qa` 는 제외). QA는 포트 4387, 4388을 쓰지 않습니다.

## 한계
- 설치, 자동 시작, 서버 실행은 Windows 전용입니다.
- 저장소에 remote가 생기기 전에 제출한 기획안은 `local/<name>` 제품 키를 그대로 가집니다.
- Orca 모바일 앱 안에서 휴대폰으로 누르는 동작은 기계로 검증하지 않았습니다.
- 뷰어의 핀치와 이동은 Chromium의 터치 에뮬레이션으로 확인했고 실제 휴대폰으로는 확인하지 않았습니다. 의견 칸이 화면 키보드 위에 머무는 것은 기계로 확인하지 않았습니다.
- `듣기` 는 브라우저의 음성 합성을 쓰므로, 브라우저가 뒤로 가거나 화면이 꺼지면 멈출 수 있습니다.
- 닫기 뒤에도 Windows Terminal 탭은 남습니다. Orca 탭만 닫힙니다.
- 다음 행동 업데이트 전에 시작한 세션은 `/reload` 를 해야 닫기가 됩니다.
- 한 사람용입니다. tailnet 소유자 확인은 로그인 하나를 가정합니다.
- `/api/open` URL은 30000자로 제한됩니다(Windows 명령줄 한도). 더 긴 내용은 복사로 대신합니다.
- iOS는 알림 버튼을 보이지 않습니다. 알림을 눌러 페이지에서 답하세요.
- 질문 다리가 없는 런타임은 `터미널에서 답하세요` 로 낮춰집니다. 항목은 보이지만 답은 터미널에서 합니다.
- inbox가 primary일 때 만든 보드는 handback 뒤에도 inbox에 남습니다.
- 멈춘 에피소드의 마지막 메시지는 아직 묻는 것으로 치므로, 세션이 꺼져도 그 대화는 내 차례에 남습니다.
- 대화 페이지의 듣기는 눌러야 읽습니다. 저절로 읽는 일은 없습니다.
- 다시 열기에는 PC에 Orca나 Windows Terminal(Windows Terminal이면 PATH의 `omo` 도)이 있어야 합니다.
- 요약에는 구독 모델이 필요합니다. 없으면 모든 항목이 휴리스틱 요약을 씁니다.
- 저절로, 몰래 화면을 찍지 않습니다. `화면 캡처` 는 사용자가 직접 누를 때, 브라우저의 `navigator.mediaDevices.getDisplayMedia` 를 부를 수 있을 때만 됩니다. 그 밖에는 버튼이 없습니다. 거부, 미지원, 실패/오염된 프레임은 그림 없이 정확한 이유만 남기고 DOM 재구성으로 대신하지 않습니다.
- 그림은 서버에서 메타데이터 없는 평범한 PNG로 다시 인코딩하며, 원본 압축 업로드는 간직하지 않습니다.
- 초안은 브라우저 IndexedDB에 최선 노력으로 저장합니다. 저장소를 쓸 수 없거나 트랜잭션이 실패하면 작성창은 `이 기기에 초안을 저장하지 못했습니다` 라고 보이고 저장된 척하지 않습니다.
- 수정 증거는 수정 산출물, 적용된 빌드, 소유자 확인을 각각 나눠 간직합니다. `수정안 확인` 은 수정이 설치됐다고 주장하지 않고, 소유자는 여전히 문제가 남았다고 제보할 수 있습니다.
