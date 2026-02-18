import { WebClient, Block, KnownBlock } from '@slack/web-api';
import { ParsedAlert } from '../types/grafana';

const SLACK_MAX_BLOCK_TEXT = 2900;

let client: WebClient | null = null;

function getClient(): WebClient {
  if (!client) {
    const token = process.env['SLACK_BOT_TOKEN'];
    if (!token) throw new Error('SLACK_BOT_TOKEN 환경변수가 설정되지 않았습니다.');
    client = new WebClient(token);
  }
  return client;
}

function getChannelId(): string {
  const channelId = process.env['SLACK_CHANNEL_ID'];
  if (!channelId) throw new Error('SLACK_CHANNEL_ID 환경변수가 설정되지 않았습니다.');
  return channelId;
}

// "분석 시작 중" 메시지를 전송하고 ts(메시지 ID)를 반환
export async function notifyAlertReceived(parsed: ParsedAlert): Promise<string | undefined> {
  const severityEmoji = parsed.severity === 'critical' ? '🔴' : '🟡';

  const result = await getClient().chat.postMessage({
    channel: getChannelId(),
    blocks: alertBlocks(parsed, severityEmoji),
    text: `${severityEmoji} 장애 감지: ${parsed.service}`,
  });

  return result.ts;
}

// 분석 완료 시 원래 메시지를 업데이트하고, 리포트가 길면 스레드로 이어서 전송
export async function notifyAnalysisComplete(
  parsed: ParsedAlert,
  report: string,
  alertTs?: string,
): Promise<void> {
  const chunks = splitReport(report);
  const slack = getClient();
  const channel = getChannelId();

  if (alertTs) {
    // 원래 "분석 시작 중" 메시지를 "분석 완료"로 업데이트
    await slack.chat.update({
      channel,
      ts: alertTs,
      blocks: completedBlocks(parsed, chunks[0]),
      text: `✅ 분석 완료: ${parsed.service} ${parsed.alertType}`,
    });

    // 리포트가 길면 나머지를 스레드로 전송
    for (let i = 1; i < chunks.length; i++) {
      await slack.chat.postMessage({
        channel,
        thread_ts: alertTs,
        blocks: [{ type: 'section', text: { type: 'mrkdwn', text: chunks[i] } }],
        text: `(${i + 1}/${chunks.length})`,
      });
    }
  } else {
    // alertTs가 없으면 새 메시지로 전송
    const result = await slack.chat.postMessage({
      channel,
      blocks: completedBlocks(parsed, chunks[0]),
      text: `✅ 분석 완료: ${parsed.service} ${parsed.alertType}`,
    });

    for (let i = 1; i < chunks.length; i++) {
      await slack.chat.postMessage({
        channel,
        thread_ts: result.ts,
        blocks: [{ type: 'section', text: { type: 'mrkdwn', text: chunks[i] } }],
        text: `(${i + 1}/${chunks.length})`,
      });
    }
  }
}

export async function notifyError(parsed: ParsedAlert, error: string, alertTs?: string): Promise<void> {
  const slack = getClient();
  const channel = getChannelId();

  const blocks: (Block | KnownBlock)[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: `❌ 분석 실패: ${parsed.service}` },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `에이전트 실행 중 오류가 발생했습니다:\n\`\`\`${error.slice(0, 500)}\`\`\``,
      },
    },
  ];

  if (alertTs) {
    await slack.chat.update({ channel, ts: alertTs, blocks, text: `❌ 분석 실패: ${parsed.service}` });
  } else {
    await slack.chat.postMessage({ channel, blocks, text: `❌ 분석 실패: ${parsed.service}` });
  }
}

// --- Block 빌더 ---

function alertBlocks(parsed: ParsedAlert, severityEmoji: string): (Block | KnownBlock)[] {
  return [
    {
      type: 'header',
      text: { type: 'plain_text', text: `${severityEmoji} 장애 감지: ${parsed.service}` },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*서비스*\n${parsed.service}` },
        { type: 'mrkdwn', text: `*알람 타입*\n${parsed.alertType}` },
        { type: 'mrkdwn', text: `*발생 시각*\n${parsed.incidentTime}` },
        { type: 'mrkdwn', text: `*심각도*\n${parsed.severity}` },
      ],
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*요약*\n${parsed.description}` },
    },
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: '⏳ `incident-orchestrator` 에이전트가 분석을 시작합니다...' }],
    },
  ];
}

function completedBlocks(parsed: ParsedAlert, firstChunk: string): (Block | KnownBlock)[] {
  return [
    {
      type: 'header',
      text: { type: 'plain_text', text: `✅ 분석 완료: ${parsed.service} ${parsed.alertType}` },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*서비스*\n${parsed.service}` },
        { type: 'mrkdwn', text: `*알람 타입*\n${parsed.alertType}` },
        { type: 'mrkdwn', text: `*발생 시각*\n${parsed.incidentTime}` },
        { type: 'mrkdwn', text: `*심각도*\n${parsed.severity}` },
      ],
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: firstChunk },
    },
  ];
}

function splitReport(text: string): string[] {
  if (text.length <= SLACK_MAX_BLOCK_TEXT) return [text];

  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= SLACK_MAX_BLOCK_TEXT) {
      chunks.push(remaining);
      break;
    }
    let cutAt = remaining.lastIndexOf('\n\n', SLACK_MAX_BLOCK_TEXT);
    if (cutAt <= 0) cutAt = remaining.lastIndexOf('\n', SLACK_MAX_BLOCK_TEXT);
    if (cutAt <= 0) cutAt = SLACK_MAX_BLOCK_TEXT;
    chunks.push(remaining.slice(0, cutAt));
    remaining = remaining.slice(cutAt).trimStart();
  }
  return chunks;
}
