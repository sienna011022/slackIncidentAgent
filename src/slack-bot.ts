import 'dotenv/config';
import { App } from '@slack/bolt';
import { runIncidentAgent } from './services/claude-runner';
import { splitReport } from './services/slack-notifier';

const SLACK_BOT_TOKEN = process.env['SLACK_BOT_TOKEN'];
const SLACK_APP_TOKEN = process.env['SLACK_APP_TOKEN'];

if (!SLACK_BOT_TOKEN) throw new Error('SLACK_BOT_TOKEN 환경변수가 설정되지 않았습니다.');
if (!SLACK_APP_TOKEN) throw new Error('SLACK_APP_TOKEN 환경변수가 설정되지 않았습니다. (xapp-... 형식)');

const app = new App({
  token: SLACK_BOT_TOKEN,
  appToken: SLACK_APP_TOKEN,
  socketMode: true,
});

// ─── 공통 분석 실행 함수 ────────────────────────────────────────────────────

async function runAnalysis({
  say,
  channel,
  threadTs,
  userQuery,
  loadingText,
}: {
  say: Function;
  channel: string;
  threadTs: string;
  userQuery: string;
  loadingText: string;
}): Promise<void> {
  // 1) 분석 시작 알림
  const loadingResult = await say({
    channel,
    thread_ts: threadTs,
    text: loadingText,
    blocks: [
      {
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `⏳ ${loadingText}` }],
      },
    ],
  });

  const prompt =
    `incident-orchestrator 에이전트를 사용해서 다음 내용을 분석해줘:\n\n${userQuery}`;

  try {
    const report = await runIncidentAgent(prompt);
    const chunks = splitReport(report);

    // 2) 첫 번째 청크로 로딩 메시지 업데이트
    await app.client.chat.update({
      channel,
      ts: loadingResult.ts as string,
      text: `✅ 분석 완료`,
      blocks: [
        {
          type: 'header',
          text: { type: 'plain_text', text: '✅ 분석 완료' },
        },
        {
          type: 'section',
          text: { type: 'mrkdwn', text: chunks[0] },
        },
      ],
    });

    // 3) 리포트가 길면 스레드에 이어서 전송
    for (let i = 1; i < chunks.length; i++) {
      await say({
        channel,
        thread_ts: threadTs,
        text: `(${i + 1}/${chunks.length})`,
        blocks: [
          {
            type: 'section',
            text: { type: 'mrkdwn', text: chunks[i] },
          },
        ],
      });
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error('[SlackBot] 분석 실패:', errMsg);

    await app.client.chat.update({
      channel,
      ts: loadingResult.ts as string,
      text: '❌ 분석 실패',
      blocks: [
        {
          type: 'header',
          text: { type: 'plain_text', text: '❌ 분석 실패' },
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `에이전트 실행 중 오류가 발생했습니다:\n\`\`\`${errMsg.slice(0, 500)}\`\`\``,
          },
        },
      ],
    });
  }
}

// ─── 앱 멘션 처리 (@봇 <내용>) ────────────────────────────────────────────

app.event('app_mention', async ({ event, say }) => {
  // 봇 멘션 텍스트에서 <@BOTID> 제거
  const userQuery = event.text.replace(/<@[A-Z0-9]+>/g, '').trim();

  if (!userQuery) {
    await say({
      channel: event.channel,
      thread_ts: event.ts,
      text: '분석할 내용을 함께 입력해주세요.\n예: `@봇 containerd shim 이슈 분석해줘`',
    });
    return;
  }

  console.log(`[SlackBot] 멘션 수신 (user: ${event.user}): ${userQuery.slice(0, 80)}...`);

  await runAnalysis({
    say,
    channel: event.channel,
    threadTs: (event as any).thread_ts || event.ts,
    userQuery,
    loadingText: '`incident-orchestrator` 에이전트가 분석을 시작합니다...',
  });
});

// ─── 슬래시 커맨드 처리 (/incident <내용>) ────────────────────────────────

app.command('/incident', async ({ command, ack }) => {
  await ack();

  const userQuery = command.text.trim();
  const channel = command.channel_id;

  if (!userQuery) {
    await app.client.chat.postMessage({
      channel,
      text: '분석할 내용을 입력해주세요.\n예: `/incident containerd shim 이슈 원인 분석`',
    });
    return;
  }

  console.log(`[SlackBot] /incident 커맨드 수신 (user: ${command.user_id}): ${userQuery.slice(0, 80)}...`);

  const initResult = await app.client.chat.postMessage({
    channel,
    text: `🔍 *인시던트 분석 요청*\n${userQuery}`,
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: '🔍 인시던트 분석 요청' },
      },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: userQuery },
      },
    ],
  });

  const say = async (args: any) => {
    return app.client.chat.postMessage({ channel, ...args });
  };

  await runAnalysis({
    say,
    channel,
    threadTs: initResult.ts as string,
    userQuery,
    loadingText: '`incident-orchestrator` 에이전트가 분석을 시작합니다...',
  });
});

// ─── 시작 ─────────────────────────────────────────────────────────────────

(async () => {
  await app.start();
  console.log('[SlackBot] Socket Mode 봇 시작됨');
  console.log('[SlackBot] @멘션 또는 /incident 커맨드로 분석 요청 가능');
})();
