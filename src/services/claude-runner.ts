import { spawn, execSync } from 'child_process';
import path from 'path';
import os from 'os';

const PROJECT_DIR =
  process.env['CLAUDE_PROJECT_DIR'] || path.resolve(process.cwd());

const TIMEOUT_MS = 10 * 60 * 1000; // 10분

function resolveClaudePath(): string {
  if (process.env['CLAUDE_PATH']) return process.env['CLAUDE_PATH'];

  const home = os.homedir();
  const candidates = [
    path.join(home, '.local', 'bin', 'claude'),
    path.join(home, '.npm-global', 'bin', 'claude'),
    '/usr/local/bin/claude',
    '/usr/bin/claude',
  ];

  // 파일 존재 여부로 먼저 탐색
  for (const p of candidates) {
    try {
      execSync(`test -x "${p}"`, { stdio: 'ignore' });
      console.log(`[Claude] claude 경로 발견: ${p}`);
      return p;
    } catch {
      // 다음 후보로
    }
  }

  // 쉘의 which로 최종 시도 (로그인 쉘 사용)
  try {
    const found = execSync('which claude', {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${home}/.local/bin:${home}/.npm-global/bin:/usr/local/bin:/usr/bin:/bin:${process.env['PATH'] || ''}`,
      },
    }).trim();
    if (found) {
      console.log(`[Claude] which로 claude 경로 발견: ${found}`);
      return found;
    }
  } catch {
    // which 실패 시 'claude' 그대로 반환
  }

  console.warn('[Claude] claude 경로를 찾지 못했습니다. PATH에 등록 필요.');
  return 'claude';
}

const CLAUDE_BIN = resolveClaudePath();

export async function runIncidentAgent(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    console.log(`[Claude] 에이전트 실행 시작: ${new Date().toISOString()}`);
    console.log(`[Claude] 프롬프트: ${prompt.slice(0, 100)}...`);

    const proc = spawn(CLAUDE_BIN, ['-p', prompt, '--output-format', 'text'], {
      cwd: PROJECT_DIR,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    let errorOutput = '';

    proc.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      output += text;
      process.stdout.write(`[Claude stdout] ${text}`);
    });

    proc.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      errorOutput += text;
      process.stderr.write(`[Claude stderr] ${text}`);
    });

    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      reject(new Error('Claude 에이전트 타임아웃 (10분 초과)'));
    }, TIMEOUT_MS);

    proc.on('close', (code) => {
      clearTimeout(timer);
      console.log(`[Claude] 프로세스 종료 코드: ${code}`);
      if (code === 0 && output.trim()) {
        resolve(output.trim());
      } else {
        const errMsg = errorOutput || `프로세스 종료 코드: ${code}`;
        reject(new Error(`Claude 실행 실패: ${errMsg.slice(0, 500)}`));
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`Claude CLI 실행 오류: ${err.message}. 'claude' 명령이 PATH에 있는지 확인하세요.`));
    });
  });
}
