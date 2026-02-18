import { GrafanaAlert, GrafanaWebhookPayload, ParsedAlert } from '../types/grafana';

const ALERT_TYPE_MAP: Record<string, string> = {
  memory: 'memory',
  mem: 'memory',
  heap: 'memory',
  oom: 'memory',
  cpu: 'CPU',
  processor: 'CPU',
  disk: 'disk',
  storage: 'disk',
  network: 'network',
  latency: '응답 지연',
  response: '응답 지연',
  error: '에러율',
  errorrate: '에러율',
  http: 'HTTP 에러',
  pod: 'Pod 장애',
  container: '컨테이너',
  restart: '재시작',
};

function extractService(labels: Record<string, string>): string {
  return (
    labels['service'] ||
    labels['job'] ||
    labels['app'] ||
    labels['app_kubernetes_io_name'] ||
    labels['instance']?.split(':')[0] ||
    'unknown-service'
  );
}

function extractAlertType(alertname: string): string {
  const lower = alertname.toLowerCase();
  for (const [keyword, type] of Object.entries(ALERT_TYPE_MAP)) {
    if (lower.includes(keyword)) return type;
  }
  return alertname;
}

function formatKstTime(isoString: string): string {
  const date = new Date(isoString);
  const kst = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  const year = kst.getUTCFullYear();
  const month = String(kst.getUTCMonth() + 1).padStart(2, '0');
  const day = String(kst.getUTCDate()).padStart(2, '0');
  const hour = String(kst.getUTCHours()).padStart(2, '0');
  const min = String(kst.getUTCMinutes()).padStart(2, '0');
  return `${year}-${month}-${day} ${hour}:${min} KST`;
}

function extractSeverity(labels: Record<string, string>): string {
  return labels['severity'] || labels['priority'] || 'warning';
}

export function parseAlert(alert: GrafanaAlert): ParsedAlert {
  const service = extractService(alert.labels);
  const alertname = alert.labels['alertname'] || 'UnknownAlert';
  const alertType = extractAlertType(alertname);
  const incidentTime = formatKstTime(alert.startsAt);
  const severity = extractSeverity(alert.labels);
  const summary = alert.annotations['summary'] || alert.annotations['description'] || alertname;

  const description = [
    `알람명: ${alertname}`,
    `심각도: ${severity}`,
    `요약: ${summary}`,
    alert.valueString ? `측정값: ${alert.valueString}` : '',
  ]
    .filter(Boolean)
    .join(' | ');

  return { service, alertType, incidentTime, severity, description, rawAlert: alert };
}

export function buildClaudePrompt(parsed: ParsedAlert): string {
  return (
    `incident-orchestrator 에이전트를 사용해서 분석해줘: ` +
    `${parsed.service}에서 ${parsed.incidentTime}에 ${parsed.alertType} 알람이 발생했어. ` +
    `${parsed.description}`
  );
}

export function getFiringAlerts(payload: GrafanaWebhookPayload): GrafanaAlert[] {
  return payload.alerts.filter((a) => a.status === 'firing');
}
