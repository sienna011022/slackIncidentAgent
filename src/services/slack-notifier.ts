import { WebClient, Block, KnownBlock } from '@slack/web-api';
import { GrafanaWebhookPayload } from '../types/grafana';

const SLACK_MAX_BLOCK_TEXT = 2900;
const SLACK_HEADER_MAX = 150;

function headerText(text: string): string {
  return text.length <= SLACK_HEADER_MAX ? text : text.slice(0, SLACK_HEADER_MAX - 1) + '…';
}

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
export async function notifyAlertReceived(title: string, payload: GrafanaWebhookPayload): Promise<string | undefined> {
  const firingCount = payload.alerts.filter((a) => a.status === 'firing').length;
  const status = payload.status === 'firing' ? '🔴' : '🟡';

  const result = await getClient().chat.postMessage({
    channel: getChannelId(),
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: headerText(`${status} ${title}`) },
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*상태*\n${payload.status}` },
          { type: 'mrkdwn', text: `*Firing 알람 수*\n${firingCount}건` },
        ],
      },
      {
        type: 'context',
        elements: [{ type: 'mrkdwn', text: '⏳ `incident-orchestrator` 에이전트가 분석을 시작합니다...' }],
      },
    ],
    text: `${status} 장애 감지: ${title}`,
  });

  return result.ts;
}

// 분석 완료 시 원래 메시지를 업데이트하고, 리포트가 길면 스레드로 이어서 전송
export async function notifyAnalysisComplete(
  title: string,
  report: string,
  alertTs?: string,
): Promise<void> {
  const chunks = splitReport(report);
  const slack = getClient();
  const channel = getChannelId();

  const completedBlocks: (Block | KnownBlock)[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: headerText(`✅ 분석 완료: ${title}`) },
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: chunks[0] },
    },
  ];

  if (alertTs) {
    await slack.chat.update({
      channel,
      ts: alertTs,
      blocks: completedBlocks,
      text: `✅ 분석 완료: ${title}`,
    });

    for (let i = 1; i < chunks.length; i++) {
      await slack.chat.postMessage({
        channel,
        thread_ts: alertTs,
        blocks: [{ type: 'section', text: { type: 'mrkdwn', text: chunks[i] } }],
        text: `(${i + 1}/${chunks.length})`,
      });
    }
  } else {
    const result = await slack.chat.postMessage({
      channel,
      blocks: completedBlocks,
      text: `✅ 분석 완료: ${title}`,
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

export async function notifyError(title: string, error: string, alertTs?: string): Promise<void> {
  const slack = getClient();
  const channel = getChannelId();

  const blocks: (Block | KnownBlock)[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: headerText(`❌ 분석 실패: ${title}`) },
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
    await slack.chat.update({ channel, ts: alertTs, blocks, text: `❌ 분석 실패: ${title}` });
  } else {
    await slack.chat.postMessage({ channel, blocks, text: `❌ 분석 실패: ${title}` });
  }
}

export function splitReport(text: string): string[] {
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
