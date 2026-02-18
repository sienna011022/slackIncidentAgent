import { spawn } from 'child_process';
import path from 'path';

const PROJECT_DIR =
  process.env['CLAUDE_PROJECT_DIR'] || path.resolve(process.cwd());

const TIMEOUT_MS = 10 * 60 * 1000; // 10분

export async function runIncidentAgent(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    console.log(`[Claude] 에이전트 실행 시작: ${new Date().toISOString()}`);
    console.log(`[Claude] 프롬프트: ${prompt.slice(0, 100)}...`);

    const proc = spawn('claude', ['-p', prompt, '--output-format', 'text'], {
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
