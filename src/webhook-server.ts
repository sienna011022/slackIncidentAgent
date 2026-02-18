import 'dotenv/config';
import express, { Request, Response } from 'express';
import { GrafanaWebhookPayload } from './types/grafana';
import { parseAlert, buildClaudePrompt, getFiringAlerts } from './utils/alert-parser';
import { runIncidentAgent } from './services/claude-runner';
import { notifyAlertReceived, notifyAnalysisComplete, notifyError } from './services/slack-notifier';

const app = express();
app.use(express.json());

const PORT = Number(process.env['PORT'] || 3000);
const WEBHOOK_SECRET = process.env['WEBHOOK_SECRET'];

// 인증 미들웨어 (WEBHOOK_SECRET이 설정된 경우만 검사)
function validateSecret(req: Request, res: Response, next: () => void): void {
  if (!WEBHOOK_SECRET) {
    next();
    return;
  }
  const token = req.headers['x-grafana-webhook-token'];
  if (token !== WEBHOOK_SECRET) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
}

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.post('/webhook', validateSecret, (req: Request, res: Response) => {
  const payload = req.body as GrafanaWebhookPayload;

  // 즉시 200 응답 (Grafana 타임아웃 방지)
  res.status(200).json({ received: true });

  const firingAlerts = getFiringAlerts(payload);
  if (firingAlerts.length === 0) {
    console.log('[Webhook] resolved 알람만 수신 - 무시');
    return;
  }

  // 각 firing alert에 대해 비동기 분석 실행
  firingAlerts.forEach((alert) => {
    const parsed = parseAlert(alert);
    const prompt = buildClaudePrompt(parsed);

    console.log(`[Webhook] 알람 수신: ${parsed.service} - ${parsed.alertType} at ${parsed.incidentTime}`);

    // 비동기 파이프라인 (응답과 무관하게 실행)
    (async () => {
      let alertTs: string | undefined;
      try {
        alertTs = await notifyAlertReceived(parsed);
        const report = await runIncidentAgent(prompt);
        await notifyAnalysisComplete(parsed, report, alertTs);
        console.log(`[Webhook] 분석 완료: ${parsed.service}`);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`[Webhook] 분석 실패 (${parsed.service}): ${errMsg}`);
        try {
          await notifyError(parsed, errMsg, alertTs);
        } catch (slackErr) {
          console.error('[Webhook] Slack 에러 알림 전송 실패:', slackErr);
        }
      }
    })();
  });
});

app.listen(PORT, () => {
  console.log(`[Server] Grafana Webhook 서버 시작 - port ${PORT}`);
  console.log(`[Server] 헬스체크: http://localhost:${PORT}/health`);
  console.log(`[Server] 웹훅 엔드포인트: POST http://localhost:${PORT}/webhook`);
  if (!WEBHOOK_SECRET) {
    console.warn('[Server] WEBHOOK_SECRET이 설정되지 않았습니다. 인증 없이 모든 요청 허용.');
  }
});
