# Code Intel 개선 Action Plan

작성일: 2026-07-31

## 목표

현재 Code Intel의 가장 큰 제약은 개별 language server의 기능 부족이 아니라,
요청마다 LSP 프로세스를 새로 실행하고 pull diagnostics만 요청하는 통합
방식이다. 이 계획의 목표는 다음 세 가지다.

1. 저장소별 persistent LSP session으로 실제 workspace 의미론을 유지한다.
2. push/pull diagnostics를 모두 수용하고 결과의 출처와 신선도를 보고한다.
3. 설정에 적힌 기대 capability와 서버가 실제 광고·수행하는 capability를
   구분한다.

기능 수를 먼저 늘리기보다 lifecycle, diagnostics, capability evidence를
신뢰할 수 있게 만드는 것을 우선한다.

## 확인된 기준선

### 저장소

- 독립 저장소: `https://github.com/j3bit/code-intel.git`
- 로컬 브랜치: `codex/omo-style-code-intel-flow`
- 조사 시점 로컬 HEAD: `1434ff8`
- 원격 `main`보다 10 commits ahead, divergence 없음
- `git push --dry-run --set-upstream` 성공
- 상위 `j3bit/skills`에는 독립 checkout을 남기고 기존 tracked tree만 제거
- 계획 작성 당시 hermetic validation은 180/180 통과
- 계획 작성 당시 사용자 설정을 그대로 읽는 validation은 Markdown이 생성한 report까지
  inventory에 포함해 179/180이다. 테스트가 ambient user settings에
  의존하는 문제로 별도 격리가 필요하다.

## 구현 진행 상황

- 2026-07-31: P0-1 fixture 단계 완료. LSP method oracle,
  process/lifecycle trace, 동일 MCP 프로세스의 연속 호출, 문서
  open/change/close, crash, push-only diagnostics gap fixture, init inventory
  oracle를 추가했다.
- init/doctor validation을 ambient user settings에서 격리했다.
- 2026-07-31: P0-2 완료. 장기 실행 MCP 경로에 repository-scoped LSP
  session manager를 연결했다. session key는 repository, resolved
  executable/argv, language, initialization options를 포함한다.
- 같은 session의 initialize 재사용, 문서 open/change/close와 version 증가,
  repository/initialization options 격리, idle/MCP 종료 cleanup, crash 후
  1회 재시작을 검증한다. `post_edit_audit`도 저장소 안의 여러 파일에서 같은
  session을 사용한다.
- 2026-07-31: P0-3 완료. initialize의 `diagnosticProvider`에 따라 pull
  request와 push notification cache를 선택하고, 결과에 transport,
  document version, 수집 시각, stale 여부를 포함한다.
- push clear notification, 이전 version 거부, notification timeout,
  `post_edit_audit` provenance를 fixture로 검증한다.
- 현재 사용자 설정을 포함한 기본 validation은 210/210 통과한다.

### 사용자 언어 도구

| 언어 | AST | LSP | 현재 Code Intel 실측 |
|---|---|---|---|
| Bash | ast-grep 0.45.0 내장 | Shuck 0.0.45, Bash LS 5.6.0 rollback | symbols, pull diagnostics 성공 |
| Zsh | `tree-sitter-zsh` custom dylib | Shuck 0.0.45 | symbols, pull diagnostics 성공 |
| Markdown | ast-grep 0.45.0 내장 | markdown-oxide 0.25.12 | symbols 성공, direct rename 요청 성공 |
| tcsh/csh | 기존 custom dylib | tcsh-lsp 0.1.0 local binary | symbols 성공 |

Markdown의 `prepareRename`과 pull diagnostics, tcsh-lsp의 pull diagnostics는
지원되지 않는다. 이는 서버 결함으로 단정할 항목이 아니라 현재 Code Intel이
optional prepare-rename과 push diagnostics를 충분히 처리하지 못하는
통합 문제다.

## 설계 원칙

- 한 저장소·서버 조합에는 한 session을 재사용한다.
- 설정의 capability 문자열은 기대값이며, initialize 응답과 method probe가
  실제 사용 가능 여부의 근거다.
- diagnostics 결과에는 `push` 또는 `pull`, 문서 version, 수집 시점을
  반드시 포함한다.
- 전체 저장소의 파일을 무조건 열지 않는다. 사용자가 만진 문서와 서버의
  workspace indexing을 우선한다.
- rename과 formatting은 계속 preview-only 경계를 유지한다.
- 기존 `commands: ["server --stdio"]` 설정은 호환하되 새 설정은 structured
  argv를 권장한다.

## 실행 순서

### P0-1. 실행 가능한 LSP fixture를 먼저 강화

대상:

- `fixtures/lsp/`
- `fixtures/repos/`
- `scripts/validate-plugin.js`

작업:

- fake server에 process/session 식별자와 요청 횟수를 추가한다.
- 기본 validation은 임시 HOME 또는 명시적인 settings path를 사용해
  개발자의 사용자 설정과 격리한다. 사용자 설정 통합은 별도 test case로
  명시한다.
- 두 tool 호출이 같은 프로세스를 재사용하는 persistent-session fixture를
  추가한다.
- `publishDiagnostics`, non-empty pull diagnostics, `didChange`,
  `didClose`, crash/restart를 각각 재현한다.
- 현재 registry의 `fixtures.repo`, `expectedAst`, `expectedLsp`를 실제
  table-driven assertion에 연결한다.
- symbols뿐 아니라 definition, references, prepare/direct rename,
  diagnostics의 성공·미지원 경로를 정확한 URI/range까지 검증한다.

완료 조건:

- 기존 validation이 계속 통과한다.
- process 재사용, push diagnostics, document lifecycle 실패를 각각
  재현하는 테스트가 구현 전에는 실패하고 구현 후에는 통과한다.
- 빈 배열이나 `null`을 단순 성공으로 세지 않고 기대 결과와 대조한다.

### P0-2. 요청별 프로세스를 repository session manager로 교체

대상:

- `mcp/code-intel-server/lsp.js`
- 새 모듈 `mcp/code-intel-server/lsp-session-manager.js`
- `mcp/code-intel-server/tools.js`
- `mcp/code-intel-server/index.js`

작업:

- 현재 `spawnSync` worker-per-request 경로를 비동기 session manager로
  교체한다.
- session key는 최소한 `repoRoot`, resolved command/argv, language ID,
  initialization options hash를 포함한다.
- session별 request ID, pending promise, streaming frame buffer,
  server capability, open-document registry를 유지한다.
- process exit, protocol error, idle timeout에서 정상 정리한다.
- crash 후 읽기 요청은 한 번만 재시작하고, 반복 실패는 명시적 degraded
  result로 반환한다.

완료 조건:

- 같은 key의 연속 tool 호출에서 initialize는 한 번만 발생한다.
- 다른 저장소나 다른 initialization options는 session을 공유하지 않는다.
- MCP 종료 시 모든 child process에 shutdown/exit를 시도하고 orphan을
  남기지 않는다.

### P0-3. push/pull diagnostics broker 구현

대상:

- `mcp/code-intel-server/lsp.js`
- 새 모듈 `mcp/code-intel-server/lsp-diagnostics.js`
- `mcp/code-intel-server/audit.js`
- `mcp/code-intel-server/audit-result.js`

작업:

- initialize의 `diagnosticProvider`를 보고 pull 지원 여부를 판정한다.
- `textDocument/publishDiagnostics` notification을 URI와 document
  version별로 캐시한다.
- pull server에는 `textDocument/diagnostic`을 사용하고, push-only
  server에는 didOpen/didChange 이후 제한된 settle window 동안 최신
  notification을 기다린다.
- 결과에 `transport`, `documentVersion`, `collectedAt`, `stale`을 넣는다.
- 빈 diagnostics, clear notification, unchanged pull report를 구분한다.

완료 조건:

- JSON/Shuck 같은 pull server와 YAML/Markdown/tcsh 같은 push server를
  동일한 `lsp_diagnostics` 계약으로 조회할 수 있다.
- `post_edit_audit`가 `Method not found` 대신 실제 push cache 또는
  이유가 명확한 timeout을 보고한다.
- 이전 문서 version의 diagnostics를 현재 결과로 오인하지 않는다.

### P1-1. 문서·workspace lifecycle 완성

대상:

- `mcp/code-intel-server/lsp-session-manager.js`
- `mcp/code-intel-server/lsp.js`
- `mcp/code-intel-server/repo.js`

작업:

- open/change/close를 URI, text hash, monotonically increasing version으로
  관리한다.
- 이미 열린 파일은 매 요청마다 다시 `didOpen`하지 않고 변경 시
  `didChange`를 보낸다.
- `workspaceFolders`, `workspace/didChangeWorkspaceFolders`, watched-file
  event의 최소 공통 동작을 지원한다.
- repository 전체 `didOpen`은 하지 않는다. server-native indexing과
  사용 문서 lifecycle을 우선한다.

완료 조건:

- multi-file definition/reference fixture가 source target을 찾는다.
- 파일 수정 후 stale symbol/diagnostic이 재사용되지 않는다.
- close 후 문서 상태와 push diagnostic cache가 정리된다.

### P1-2. 설정과 runtime capability를 분리

대상:

- `settings/schema.json`
- `settings/defaults.json`
- `mcp/code-intel-server/settings.js`
- `mcp/code-intel-server/capabilities.js`
- `scripts/doctor-code-intel.js`

작업:

- `lsp.languageId`, structured `command`/`args`,
  `initializationOptions`, server settings를 추가한다.
- 기존 `commands` 배열은 backward-compatible shorthand로 유지한다.
- configured capability는 `expectedCapabilities`로 취급하고 initialize
  응답과 method 결과를 `advertised`, `verified`, `unsupported`로 나눈다.
- 첫 executable이 실행 중 실패하면 다음 candidate를 시험하는 health
  policy를 추가한다.
- TypeScript의 project-local tsserver 경로처럼 서버별 초기화 설정을
  전달할 수 있게 한다.

완료 조건:

- command 존재만으로 `diagnostics available`을 보고하지 않는다.
- Markdown처럼 direct rename은 되지만 `prepareRename`이 없는 서버를
  정상적으로 표현한다.
- doctor가 기대 capability와 실제 capability 차이, 사용 중인 candidate,
  마지막 실패 원인을 보여 준다.

### P1-3. 언어 판별과 AST capability probe 개선

대상:

- `mcp/code-intel-server/capabilities.js`
- `mcp/code-intel-server/repo.js`
- `scripts/init-code-intel.js`
- `scripts/doctor-code-intel.js`

작업:

- extension 외에 exact filename, glob, shebang 판별을 지원한다.
- `.zshrc`, `.bashrc`, extensionless executable을 올바른 language ID로
  보낸다.
- ast-grep executable 존재 여부가 아니라 언어별 최소 parse smoke로
  custom grammar load를 검증한다.
- extension 충돌 시 insertion order 대신 명시적 precedence와 근거를
  보고한다.

완료 조건:

- `.zshrc`, `.bashrc`, shebang-only fixture가 각각 올바르게 route된다.
- 손상되거나 ABI가 맞지 않는 custom dylib는 `available`로 보고되지 않는다.

### P2-1. session을 활용하는 읽기 기능 노출

대상:

- `mcp/code-intel-server/tools.js`
- `references/mcp-tool-contract.md`
- 관련 skills와 validation

순서:

1. hover
2. completion
3. semantic tokens
4. formatting preview

각 tool은 initialize capability를 확인하고, completion/semantic token의
대량 결과에는 상한을 둔다. formatting은 파일을 쓰지 않고 `TextEdit`
preview만 반환한다.

완료 조건:

- 미지원 method는 호출 전에 명확히 unavailable로 판정한다.
- formatting과 rename은 실제 파일을 변경하지 않는다.
- 반환 크기 제한과 truncation metadata가 있다.

### P2-2. 현실 corpus와 optional integration matrix 추가

작업:

- 필수 CI는 deterministic fake servers로 유지한다.
- opt-in integration suite에 Shuck, bash-language-server,
  markdown-oxide, tcsh-lsp, slang-server, PerlNavigator,
  JSON/YAML/Tcl server를 등록한다.
- tcsh와 Zsh는 실제 공개 프로젝트의 작은 고정 corpus로 parser/LSP
  regression을 검증한다.
- 버전과 executable path를 결과 artifact에 기록한다.

완료 조건:

- 서버 upgrade 전후의 method별 성공/실패 차이를 비교할 수 있다.
- optional tool 부재는 CI 실패가 아니라 명시적 skip이며, 설치된 tool의
  protocol regression은 실패로 처리한다.

## 권장 PR 단위

| PR | 범위 | 선행 조건 |
|---|---|---|
| 1 | fixture oracle와 lifecycle 실패 테스트 | 없음 |
| 2 | async session manager와 종료 정책 | PR 1 |
| 3 | push/pull diagnostics broker | PR 2 |
| 4 | document/workspace lifecycle | PR 2 |
| 5 | settings v2-compatible 확장과 capability negotiation | PR 2 |
| 6 | filename/glob/shebang 및 AST language probe | PR 5 |
| 7 | hover/completion/semantic/format preview | PR 3–5 |
| 8 | optional real-server integration matrix | PR 3–6 |

PR 2–4는 한 번에 합치지 않는다. session lifecycle, diagnostics freshness,
workspace indexing은 실패 양상이 달라 독립적으로 검토·rollback할 수 있어야
한다.

## 이번 범위에서 하지 않을 일

- 모든 파일을 열어 workspace indexing을 흉내 내지 않는다.
- 서버별 custom protocol을 일반 LSP인 것처럼 추상화하지 않는다.
- tcsh-lsp에 pull diagnostics만 임시 추가해 Code Intel의 push 지원
  부재를 가리지 않는다.
- Shuck 0.0.x를 유일한 복구 경로로 두지 않는다. Bash LS는 rollback
  candidate로 유지한다.
- persistent session 안정화 전에 formatting이나 completion부터 노출하지
  않는다.

## 운영 후속 조치

- 현재 tcsh-lsp 경로는 최신 local build를 쓰기 위한 debug binary다.
  tcsh-lsp 작업 트리를 정리한 뒤 versioned release 또는 stable local-bin
  경로로 교체한다.
- 독립 code-intel 브랜치를 원격에 게시하고 PR에서 10개 선행 commits와
  이 계획을 함께 검토한다.
- 사용자 설정의 Shuck과 Zsh grammar 버전을 doctor 출력에 기록해 upgrade
  시점을 재현 가능하게 만든다.

## 참고 자료

- [Shuck](https://github.com/ewhauser/shuck)
- [Bash Language Server](https://github.com/bash-lsp/bash-language-server)
- [tree-sitter-zsh](https://github.com/georgeharker/tree-sitter-zsh)
- [markdown-oxide](https://github.com/Feel-ix-343/markdown-oxide)
- [ast-grep custom language](https://ast-grep.github.io/advanced/custom-language.html)
