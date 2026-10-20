# CLAUDE.md

- README.md is the authoritative spec. Change behavior there first, then the code.
- README.ko.md is its Korean translation. Edit it in the same commit as README.md, with the same headings in the same order.
- Test: `node --test "test/**/*.test.mjs"`.
- No build, no lint, no dependencies. Node 24 built-ins only (`import x from "node:..."`), ESM `.mjs`, tabs, double quotes, semicolons.
- Tests never wait on real time: inject clocks and timers, await events, use port 0, set `INBOX_WAIT_POLL_MS` / `INBOX_ENSURE_POLL_MS` small. Use temp homes from `test/helpers/tmp-home.mjs` and fake runners for `reg`, `tailscale`, `wscript`.
- Never touch tailscale 443 or Funnel. Only the 4388 serve handler, always behind the 443 guard.
- Write hostnames as `<machine>.<tailnet>.ts.net`, never a real one.
- Commit messages: `omo-inbox: <what changed>`.
