// pm2: proceso propio, separado del backend de Horom.
module.exports = {
  apps: [
    {
      name: 'neuronpos-core',
      script: 'server.js',
      cwd: __dirname,
      instances: 1,
      env_production: { NODE_ENV: 'production' },
    },
  ],
};
