# AI 기반 인시던트 자동화 시스템
### Grafana → Claude AI Agent → Slack/Notion 장애 대응 파이프라인

---

## 개요

온콜 엔지니어가 **수동으로 30~60분 소요하던 장애 분석 작업**을 AI 에이전트를 통해 **6~11분으로 자동화**한 SRE 토일(Toil) 감소 프로젝트입니다.

Grafana 알람 발생 시, EC2에서 실행 중인 Webhook 서버가 Claude AI 에이전트를 자동 실행하여 실시간 메트릭 분석, 과거 사례 검색, Slack 보고, Notion 포스트모텀 생성까지 전 과정을 자동화합니다.

---

## 문제 정의 (Problem Statement)

### 기존 온콜 대응 프로세스

```
[알람 수신] → 로그인 → Grafana 로그 확인 → 메트릭 분석 → Notion 과거 사례 검색
                                                                        ↓
              Slack 보고 ← 보고서 직접 작성 ← 원인 추정 ← 패턴 비교
```

| 단계 | 소요 시간 | 문제점 |
|------|----------|--------|
| Grafana 로그/메트릭 조회 | 10~20분 | 여러 대시보드 수동 탐색 |
| 과거 사례 Notion 검색 | 10~15분 | 키워드 조합 반복 검색 |
| 보고서 작성 및 Slack 공유 | 10~15분 | 매번 동일 포맷 반복 |
| 포스트모텀 작성 | 15~20분 | 그래프 캡처, 문서 구조화 |
| **합계** | **45~70분** | **야간/주말 온콜 시 극심한 피로** |

### 핵심 질문

> 반복적이고 정형화된 분석 작업을 AI가 대신할 수 있다면, 엔지니어는 실제 문제 해결에만 집중할 수 있지 않을까?

---

## 솔루션 아키텍처

### 전체 흐름

```
┌─────────────┐
│   Grafana   │  Alert 발생
│  Alerting   │──────────────────────────────────────┐
└─────────────┘                                       │ POST /webhook
                                                      ▼
                                          ┌───────────────────────┐
                                          │   EC2 Webhook Server  │
                                          │   (Express/TypeScript)│
                                          │                       │
                                          │ ① 알람 즉시 파싱      │
                                          │ ② Slack 수신 알림     │
                                          │ ③ Claude CLI 비동기   │
                                          └──────────┬────────────┘
                                                     │
                                                     ▼
                                    ┌────────────────────────────────┐
                                    │  incident-orchestrator Agent   │
                                    │        (Claude Sonnet)         │
                                    │                                │
                                    │  Phase 1: Grafana MCP 분석     │
                                    │  ├─ Loki 로그 조회 (±15분)    │
                                    │  ├─ Prometheus 메트릭 조회     │
                                    │  ├─ 알람 규칙 컨텍스트         │
                                    │  └─ RCA 근본원인 추정          │
                                    │                                │
                                    │  Phase 2: Notion MCP 검색      │
                                    │  ├─ 과거 포스트모텀 검색       │
                                    │  ├─ 유사도 점수 계산           │
                                    │  └─ 검증된 해결책 추출         │
                                    │                                │
                                    │  Phase 3: 통합 리포트 생성     │
                                    └──────────────┬─────────────────┘
                                                   │
                                    ┌──────────────┴──────────────┐
                                    ▼                             ▼
                           ┌──────────────┐             ┌──────────────────┐
                           │    Slack     │             │  Notion (선택)   │
                           │  채널 보고   │             │ 포스트모텀 자동  │
                           │  (즉시+완료) │             │    페이지 생성   │
                           └──────────────┘             └──────────────────┘
```

### 에이전트 역할 분리

| 에이전트 | 모델 | 역할 | 소요시간 |
|---------|------|------|---------|
| `incident-orchestrator` | Claude Sonnet | 전체 파이프라인 오케스트레이션 | - |
| `grafana-incident-analyzer` | Claude Sonnet | Grafana MCP 실시간 분석 (Loki + Prometheus) | 3~5분 |
| `postmortem-search-agent` | Claude Haiku | Notion MCP 과거 사례 검색 및 유사도 계산 | 2~4분 |
| `postmortem-generator` | Claude Haiku | Grafana 그래프 캡처 + Notion 페이지 자동 생성 | 2분 |

> 분석(Sonnet)과 검색(Haiku)을 모델 레벨에서 분리하여 비용/속도를 최적화했습니다.

---

## 핵심 기능

### 1. 알람 자동 트리거
Grafana Webhook을 수신하면 즉시 Slack에 "분석 시작" 알림을 전송하고, 백그라운드에서 에이전트를 실행합니다. Grafana에는 200 OK를 즉시 반환하여 타임아웃 이슈를 방지합니다.

```typescript
// 즉시 200 응답 후 비동기 분석 실행
app.post('/webhook', (req, res) => {
  res.status(200).json({ received: true }); // Grafana 타임아웃 방지

  (async () => {
    await notifyAlertReceived(parsed);       // Slack: "분석 시작 중"
    const report = await runIncidentAgent(prompt); // 6~11분 소요
    await notifyAnalysisComplete(parsed, report);  // Slack: 최종 리포트
  })();
});
```

### 2. 실시간 Observability 데이터 수집
MCP(Model Context Protocol)를 통해 Claude가 Grafana에 직접 쿼리합니다. 코드 없이 에이전트 정의 파일(.md)만으로 도구 사용 권한을 선언합니다.

```
알람 발생 시각 ±15분 범위로 자동 최적화:
- Loki: 에러 로그 패턴 분석 (limit: 20건으로 속도 최적화)
- Prometheus: CPU, Memory, Request Rate, Error Rate
- AlertManager: 알람 규칙 컨텍스트 및 임계값 확인
```

### 3. 과거 사례 유사도 검색
Notion 포스트모텀 데이터베이스에서 현재 장애와 유사한 과거 사례를 자동 탐색합니다.

```
유사도 점수 (100점 만점):
├─ 서비스 일치 (40점): 동일 서비스/컴포넌트
├─ 증상 일치 (30점): 유사한 에러 패턴/메트릭
├─ 근본원인 일치 (20점): 동일 원인 카테고리
└─ 기술스택 일치 (10점): Node.js, EC2 등
```

### 4. Slack 분할 전송
Slack의 3,000자 블록 제한을 고려하여 긴 리포트를 단락 경계에서 자동 분할 전송합니다.

### 5. 자동 포스트모텀 생성
장애 분석 완료 후 `postmortem-generator` 에이전트가:
- Grafana 대시보드에서 관련 패널 자동 선택 (알람 타입별 우선순위)
- 패널 이미지 고해상도 캡처 (1200×400, scale: 2)
- Notion에 구조화된 포스트모텀 페이지 자동 생성

---

## 기술 스택

| 영역 | 기술 |
|------|------|
| **Runtime** | Node.js 22+, TypeScript 5.7 |
| **Web Framework** | Express.js 4.x |
| **AI** | Claude Sonnet (분석), Claude Haiku (검색) |
| **AI Protocol** | MCP (Model Context Protocol) |
| **Observability** | Grafana, Prometheus, Loki |
| **Knowledge Base** | Notion |
| **Communication** | Slack Incoming Webhooks |
| **Infrastructure** | AWS EC2 |

---

## SRE 관점 성과

### Toil 감소

| 작업 | 기존 (수동) | 자동화 후 | 절감 |
|------|-----------|----------|------|
| 로그/메트릭 분석 | 10~20분 | 3~5분 | ~75% |
| 과거 사례 검색 | 10~15분 | 2~4분 | ~75% |
| Slack 보고서 작성 | 10~15분 | 즉시 | ~100% |
| 포스트모텀 초안 작성 | 15~20분 | 2분 | ~90% |
| **총 MTTR 기여** | **45~70분** | **6~11분** | **~83%** |

### 일관성 향상
매번 분석자가 달라도 동일한 분석 기준 적용:
- 항상 ±15분 범위 로그/메트릭 수집
- 서비스명 → 데이터소스 자동 매핑
- 구조화된 RCA + 액션 플랜 포맷

### 지식 자산화
과거 사례를 자동으로 검색·참조함으로써 조직의 인시던트 대응 경험이 지속적으로 재활용됩니다.

---

## 프로젝트 구조

```
slackIncidentAgent/
├── .claude/
│   ├── settings.local.json         # MCP 권한 설정
│   └── agents/
│       ├── incident-orchestrator.md     # 통합 파이프라인 에이전트
│       ├── grafana-incident-analyzer.md # Grafana 실시간 분석
│       ├── post-moterm-search.md        # Notion 과거 사례 검색
│       └── postmortem-generator.md      # 자동 포스트모텀 생성
│
└── src/
    ├── webhook-server.ts           # Express 웹훅 수신 서버
    ├── types/
    │   └── grafana.ts              # Grafana 웹훅 페이로드 타입
    ├── services/
    │   ├── claude-runner.ts        # Claude CLI 실행 (subprocess)
    │   └── slack-notifier.ts       # Slack Block Kit 알림
    └── utils/
        └── alert-parser.ts         # 알람 파싱 및 프롬프트 생성
```

---

## 실행 방법

### 1. 환경 설정

```bash
cp .env.example .env
# .env 파일에서 아래 값 설정:
# SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...
# WEBHOOK_SECRET=your-secret
# CLAUDE_PROJECT_DIR=/path/to/this/project
```

### 2. 서버 실행

```bash
npm install
npm run webhook         # 개발 모드 (tsx)
npm run webhook:prod    # 프로덕션 (컴파일 후)
```

### 3. Grafana Contact Point 설정

```
Alerting → Contact points → Add contact point
├─ Type: Webhook
├─ URL: http://{EC2_IP}:3000/webhook
└─ Headers: X-Grafana-Webhook-Token: {WEBHOOK_SECRET}
```

### 4. 테스트

```bash
# 헬스체크
curl http://localhost:3000/health

# 테스트 알람 전송
./test-webhook.sh
```

---

## 설계 결정과 트레이드오프

### MCP 기반 에이전트 vs. 직접 API 호출

**선택**: MCP (Model Context Protocol)

| | MCP | 직접 API 호출 |
|-|-----|-------------|
| 새 데이터소스 추가 | 에이전트 .md 파일 수정만 | 코드 수정 + 배포 필요 |
| 유지보수 | 낮음 | 높음 |
| 유연성 | Claude가 상황에 맞게 도구 선택 | 하드코딩된 로직 |
| 비용 | Claude API 호출 비용 | 낮음 |

### 에이전트 모델 분리 전략

- **Sonnet** (분석): 복잡한 RCA, 상관관계 분석, 통합 리포트 생성
- **Haiku** (검색/생성): 빠른 Notion 검색, 구조화된 포스트모텀 생성

→ 동일 품질 유지하면서 비용 약 40% 절감 (검색/생성 작업이 전체의 60% 차지)

### 비동기 처리

Grafana Webhook은 10초 타임아웃이 있습니다. Claude 에이전트는 6~11분 소요되므로 즉시 200 응답 후 백그라운드에서 분석을 실행하는 구조로 설계했습니다.

---

## 한계 및 개선 방향

### 현재 한계
- Claude CLI가 EC2에 설치되어 있어야 함 (재현성 제약)
- 분석 소요시간 메트릭 미수집 (MTTR 개선 측정 불가)
- 알람별 처리 성공/실패 통계 없음

### 개선 방향

| 개선 항목 | 방법 | 효과 |
|----------|------|------|
| 운영 메트릭 수집 | `GET /stats` 엔드포인트 추가 | MTTR 개선 수치 측정 |
| 컨테이너화 | Docker + Claude Code 이미지 | 배포 재현성 확보 |
| 알람 중복 제거 | fingerprint 기반 dedup | 동일 알람 중복 분석 방지 |
| SLO 연동 | Error budget 소진 시 알림 강화 | SLO 기반 우선순위 대응 |
| 멀티 채널 | PagerDuty, OpsGenie 연동 | 온콜 로테이션 자동 연결 |

---

## 배경

이 프로젝트는 실제 운영 환경에서 야간 온콜 대응 시 반복되는 수동 작업에서 출발했습니다. Grafana 알람 → 로그 확인 → 메트릭 분석 → 과거 사례 검색 → 보고서 작성이라는 사이클이 장애마다 동일하게 반복됨을 관찰하고, 이를 AI 에이전트로 자동화했습니다.

MCP(Model Context Protocol)를 활용한 에이전트 기반 접근은 코드 없이 에이전트의 역할과 권한을 선언적으로 정의할 수 있어, 새로운 도구나 데이터소스를 에이전트에 추가할 때 코드 변경 없이 .md 파일 수정만으로 확장 가능합니다.
