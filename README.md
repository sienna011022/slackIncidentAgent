# Slack Incident Agent

Grafana 알람 발생 시 Claude AI 에이전트가 자동으로 장애를 분석하여 Slack으로 보고하는 시스템입니다.

```
Grafana Alert → EC2 Webhook Server → Claude Agent → Slack
Slack 멘션/@봇 → Slack Bot (Socket Mode) → Claude Agent → Slack
```

---

## 동작 방식

### Webhook 모드 (Grafana 자동 트리거)
1. Grafana가 알람을 발생시키면 EC2의 Webhook 서버로 전송
2. 서버가 즉시 Slack에 "분석 시작 중" 알림 전송
3. `incident-orchestrator` 에이전트가 자동 실행
   - **Phase 1** — Grafana MCP로 Loki 로그 + Prometheus 메트릭 분석
   - **Phase 2** — Notion MCP로 과거 포스트모텀 사례 검색
   - **Phase 3** — 통합 분석 리포트 생성
4. 완성된 리포트를 Slack 채널로 전송

### Slack Bot 모드 (수동 요청)
1. Slack에서 봇을 멘션하거나 `/incident` 커맨드로 분석 요청
2. `incident-orchestrator` 에이전트가 자동 실행
3. 완성된 리포트를 스레드로 전송

---

## 사전 요구사항

- Node.js 22+
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) 설치 및 로그인
- Grafana (Loki + Prometheus 연동)
- Slack App (Bot Token + App Token)
- Notion 연동 (과거 사례 검색용, 선택)

---

## 설치

```bash
git clone <repo-url>
cd slackIncidentAgent

npm install

cp .env.example .env
# .env 파일 편집 (아래 환경변수 섹션 참고)
```

---

## 환경변수

`.env` 파일에 다음 값을 설정합니다.

| 변수 | 필수 | 설명 |
|------|------|------|
| `SLACK_BOT_TOKEN` | ✅ | Slack Bot Token (`xoxb-`로 시작) |
| `SLACK_APP_TOKEN` | ✅ (Bot 모드) | Slack App-Level Token (`xapp-`로 시작), Socket Mode용 |
| `SLACK_CHANNEL_ID` | ✅ (Webhook 모드) | 메시지를 전송할 채널 ID (`C`로 시작) |
| `PORT` | - | 웹훅 서버 포트 (기본값: `3000`) |
| `WEBHOOK_SECRET` | - | Grafana 인증 토큰 (설정 시 헤더 검증) |
| `CLAUDE_PROJECT_DIR` | - | 프로젝트 루트 경로 (기본값: `process.cwd()`) |
| `CLAUDE_PATH` | - | claude CLI 절대경로 (자동 탐지 실패 시 수동 지정) |

---

## 실행

```bash
# Webhook 서버 (Grafana 알람 수신)
npm run webhook

# Slack Bot (Socket Mode, 멘션/@incident 커맨드 응답)
npm run bot
```

### 백그라운드 실행 (EC2)

```bash
mkdir -p logs

nohup npm run webhook > logs/webhook.log 2>&1 &
nohup npm run bot     > logs/bot.log     2>&1 &
```

### Slack Bot 사용법

```
# 봇 멘션
@봇이름 ip-10-20-38-11 노드에서 containerd shim 이슈 분석해줘

# 슬래시 커맨드
/incident teamwalk-api 2026-02-20 10:00 메모리 급증
```

---

## Grafana 설정

### Contact Point 추가

1. Grafana → **Alerting → Contact points → Add contact point**
2. Type: **Webhook**
3. URL: `http://{EC2_IP}:3000/webhook`
4. (선택) Optional HTTP headers:
   ```
   X-Grafana-Webhook-Token: {WEBHOOK_SECRET 값}
   ```

### Notification Policy 연결

Alerting → **Notification policies** 에서 원하는 알람 그룹에 위 Contact Point를 연결합니다.

---

## 테스트

```bash
# 헬스체크
curl http://localhost:3000/health

# 테스트 알람 전송
./test-webhook.sh

# 특정 서버로 테스트
WEBHOOK_SECRET=my-secret ./test-webhook.sh http://my-ec2-ip:3000
```

---

## 에이전트 구성

에이전트는 `.claude/agents/` 폴더의 Markdown 파일로 정의됩니다.

| 에이전트 | 파일 | 역할 |
|---------|------|------|
| `incident-orchestrator` | `incident-orchestrator.md` | 전체 파이프라인 실행 (메인) |
| `grafana-incident-analyzer` | `grafana-incident-analyzer.md` | Grafana 실시간 분석 |
| `postmortem-search-agent` | `post-moterm-search.md` | Notion 과거 사례 검색 |
| `postmortem-generator` | `postmortem-generator.md` | Grafana 그래프 캡처 + Notion 포스트모텀 자동 생성 |

에이전트를 Claude Code에서 직접 실행할 수도 있습니다.

```
# Claude Code 대화창에서
"teamwalk-api에서 2026-02-17 10:00에 메모리 알람 발생했어"
```

---

## 프로젝트 구조

```
slackIncidentAgent/
├── .claude/
│   ├── settings.local.json     # MCP 권한 설정
│   └── agents/                 # 에이전트 정의 파일
├── src/
│   ├── webhook-server.ts       # Express 웹훅 서버 (Grafana 알람 수신)
│   ├── slack-bot.ts            # Slack Bot (Socket Mode, 멘션/커맨드 응답)
│   ├── types/grafana.ts        # Grafana 웹훅 페이로드 타입
│   └── services/
│       ├── claude-runner.ts    # Claude CLI 실행 (경로 자동 탐지)
│       └── slack-notifier.ts   # Slack 알림 전송
├── .env.example
├── test-webhook.sh             # 로컬 테스트용 스크립트
├── PORTFOLIO.md                # 프로젝트 상세 설명 (SRE 포트폴리오)
└── package.json
```

---

## 포스트모텀 자동 생성 (선택)

장애 분석 완료 후 Claude Code에서 `postmortem-generator` 에이전트를 실행하면:

- Grafana 대시보드에서 관련 패널 자동 선택 및 이미지 캡처
- Notion에 구조화된 포스트모텀 페이지 자동 생성
- 사용자는 이미지 업로드 및 최종 검토만 진행 (약 5분)

> Grafana Image Renderer 플러그인이 설치되어 있어야 합니다.
> ```bash
> grafana-cli plugins install grafana-image-renderer
> ```

---

## 관련 문서

- [PORTFOLIO.md](./PORTFOLIO.md) — 설계 결정, 성과 수치, SRE 관점 상세 설명
