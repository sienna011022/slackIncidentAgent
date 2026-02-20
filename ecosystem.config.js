module.exports = {
  apps: [
    {
      name: 'slack-bot',
      script: 'node_modules/.bin/tsx',
      args: 'src/slack-bot.ts',
      cwd: __dirname,
      interpreter: 'none',
      env_file: '.env',
      restart_delay: 5000,
      max_restarts: 10,
      out_file: 'logs/bot-out.log',
      error_file: 'logs/bot-err.log',
      time: true,
    },
  ],
};
