#!/bin/bash
# Grafana 웹훅 테스트 스크립트
# 사용법: ./test-webhook.sh [서버URL]

SERVER_URL="${1:-http://localhost:3000}"
SECRET="${WEBHOOK_SECRET:-}"

echo "=== Grafana 웹훅 테스트 ==="
echo "서버: $SERVER_URL"
echo ""

# 1. 헬스체크
echo "1. 헬스체크..."
curl -s "$SERVER_URL/health" | python3 -m json.tool
echo ""

# 2. 테스트 알람 전송
echo "2. 테스트 알람 전송 (firing)..."
curl -s -X POST "$SERVER_URL/webhook" \
  -H "Content-Type: application/json" \
  ${SECRET:+-H "X-Grafana-Webhook-Token: $SECRET"} \
  -d '{
    "receiver": "incident-agent",
    "status": "firing",
    "alerts": [
      {
        "status": "firing",
        "labels": {
          "alertname": "HighMemoryUsage",
          "service": "teamwalk-api",
          "severity": "critical",
          "instance": "ip-172-31-138-92:9100"
        },
        "annotations": {
          "summary": "메모리 사용률 96.6% 초과",
          "description": "teamwalk-api 서버 메모리 사용률이 임계값(90%)을 초과했습니다."
        },
        "startsAt": "'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'",
        "endsAt": "0001-01-01T00:00:00Z",
        "generatorURL": "",
        "fingerprint": "abc123",
        "silenceURL": "",
        "dashboardURL": "",
        "panelURL": "",
        "values": null,
        "valueString": "[ var='A' labels={} value=96.6 ]"
      }
    ],
    "groupLabels": {"alertname": "HighMemoryUsage"},
    "commonLabels": {"service": "teamwalk-api"},
    "commonAnnotations": {},
    "externalURL": "",
    "version": "1",
    "groupKey": "{}:{alertname=\"HighMemoryUsage\"}",
    "truncatedAlerts": 0,
    "orgId": 1,
    "title": "[FIRING:1] HighMemoryUsage",
    "state": "alerting",
    "message": "메모리 알람 발생"
  }' | python3 -m json.tool
echo ""
echo "완료! Slack 채널을 확인하세요."
