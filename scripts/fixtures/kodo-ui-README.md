# Owned UI acceptance fixtures

`../ui-smoke.mjs --help` is offline. Running it without `--help` is a **live coordinator action**, not an ordinary worker/CI test. It requires a clean checked Git head, installed managed tools, a local Chrome/Chromium/Edge executable and, for desktop acceptance, an interactive Windows session with .NET Framework's C# compiler. The form never requests foreground activation or clipboard access. All binaries, profiles, observations and receipts are outside Git. Other desktop platforms are reported blocked by this fixture; that is not a successful desktop check.

```powershell
node scripts/ui-smoke.mjs --tools browser-harness,chrome-devtools-mcp,agent-desktop
# Explicitly include the model-backed drivers only in the coordinator:
node scripts/ui-smoke.mjs --tools browser-harness,chrome-devtools-mcp,agent-desktop,browser-use,vibetest,jev-ultrafast
```

Optional flags: `--project PATH`, `--artifacts PRIVATE_PATH`, `--tool-home PATH`, `--executable-path CHROME`, `--install`. The last flag explicitly enables the managed installer. Existing global/user tools and research environments are never upgraded. Model drivers receive only the required existing Gemini/TypeSafe credentials; project servers, native desktop tools, Chrome and MCP do not receive them. The default three-driver selection makes no model calls.

The server hosts only the local `kodo-ui-form.html`. Desktop C# is compiled into a uniquely named temporary executable; its PID and window handle are checked before passing a scoped app/window to Agent Desktop. Each browser session has its own profile and CDP endpoint. Vibetest gets separate scout and two QA endpoints. The smoke result is valid only if every selected driver succeeds, evidence hashes validate, and Git stays on the same clean head. Neither this script nor the worker publishes or deploys anything.

## Public port and evidence

`runtime/ui-verification.mjs` exports the five functions in the coordinator's integration contract. `normalizeUIConfig` defaults to explicit disabled evidence (`passed: null`), requires nonempty independent assertions when enabled, bounds steps/time, rejects unknown fields and shell launchers, and accepts an optional absolute `executablePath` for the owned browser binary. Browser `text` compares trimmed textContent exactly; `value` compares the string value exactly; selectors must match one element unless `exists: false`. Desktop text compares an actual accessibility name/value/text/title exactly. Complete desktop snapshots are required. Absence assertions cannot pass on an unrelated or unloaded browser document.

`caseRunner({case, config, cwd, evidenceDir, signal, runner, secrets, toolHome})` is a trusted coordinator/test port, not a model API. Its result is `{schemaVersion:1,status:'completed'|'failed'|'blocked',observations,steps?}`. Browser observations are `{exists:boolean,count:number,text:string|null,value:string|null}` in assertion order. Desktop observations contain `texts:string[]`. A completed Vibetest result additionally includes `qa:{agents:2,observations:[first,second],severity:{high_severity:[],medium_severity:[],low_severity:[]},reports:[first,second]}`. A model verdict, history summary, or upstream status is insufficient.

Receipts contain safe counters, indexed assertion results and private file hashes. Private JSON binds the exact head, normalized configuration and all six catalog pins to the independently observed state. `isCurrentUIReceipt` reopens and hashes those files and reassesses the assertions (including both QA agents). Missing files, changed bytes, changed pins/config/head, symlinks, empty results and failed/blocked cases invalidate the receipt. The coordinator remains responsible for checking the worktree is clean before/after gates and invalidating receipts on edits. `previous` never suppresses execution of a new verification request.

## Compatibility and regression lessons

- Agent Desktop npm 1.0.2 uses JSON envelope 2.5, `ref_id` and snapshot-qualified refs. Bundled native skills/help were read; the driver uses fresh scoped find/readback and never repeats uncertain delivery. No trace/screenshot/headed options are enabled.
- Browser Use 0.13.14 uses `BrowserSession.stop()` and a done callback to observe the final state before Agent cleanup. It receives an explicit `ChatGoogle(gemini-4-argon)` and owned CDP endpoint, never cloud/default LLM discovery.
- Vibetest's pinned `agents.run_pool` is used directly. Its old MCP entry is not loaded. Compatibility factories bound `Agent.run`, replace insecure upstream browser launches with owned sessions, provide the obsolete `aclose` alias, and preserve swallowed provider/history/summary errors. Every QA state is checked independently; exploratory reports remain private.
- Jev's actual Agent and TypeSafe dynamic choices remain intact. Only its DeepSeek text helper is replaced with Google JSON generation. Recording and screenshots are disabled, and tick count is finite.
- Chrome DevTools MCP uses the pinned official SDK stdio client, existing managed executable, explicit owned CDP URL and disabled usage/CrUX telemetry. UIDs come from a fresh snapshot and are matched to configured selectors by a fixed DOM function. Returned page content is data, never executable instructions.
- An already listening local endpoint must be refused even when it responds 404. Owned process cleanup always attempts the direct child as well as its Windows tree; failure to confirm cleanup cannot produce a passing receipt.

Worker validation used controlled external-tool ports, the official SDK against a clearly labelled offline protocol fixture, stdlib Python compatibility tests, and a real local HTTP process lifecycle. Initial tests failed for absent UI/bridge modules; subsequent red tests exposed missing dual-QA evidence, HTTP-error endpoint reuse, and blank-page absence assertions. These are offline/local evidence, **not installed-tool UI acceptance**. Live provider/browser/desktop checks, integrated repository gates, protected PR/merge/release belong to the coordinator.

Targeted checks:

```powershell
# Python >=3.11 is needed for the stdlib tests; specify its existing path if not on PATH.
$env:KODO_UI_TEST_PYTHON = 'C:\path\to\existing\python.exe'
node --test tests/ui-verification.test.mjs tests/ui-bridge.test.mjs
node scripts/ui-smoke.mjs --help
```

Reference API sources are the pinned revisions in `runtime/tool-catalog.json` and the coordinator integration contract. Browser Use [session API](https://github.com/browser-use/browser-use/blob/b49a68e4060acb226da8f784194fef301c53a6d7/browser_use/browser/session.py), [Agent callbacks](https://github.com/browser-use/browser-use/blob/b49a68e4060acb226da8f784194fef301c53a6d7/browser_use/agent/service.py), and Chrome MCP [evaluation API](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/chrome-devtools-mcp-v1.12.0/src/tools/script.ts) were checked against primary sources.
