module.exports = { apps: [{ name: 'delta-demo', script: 'server/index.js', cwd: '/home/ubuntu/delta-demo', max_memory_restart: '400M', autorestart: true, env: { NODE_ENV: 'production' } }] };
