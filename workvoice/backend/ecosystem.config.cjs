// PM2 : garde l'API en marche et la redémarre après un crash ou un reboot du serveur.
//   pm2 start ecosystem.config.cjs && pm2 save && pm2 startup
module.exports = {
  apps: [
    {
      name: 'workvoice-api',
      script: 'src/server.js',
      cwd: __dirname,
      instances: 1,
      env: { NODE_ENV: 'production' },
      max_memory_restart: '300M',
      out_file: 'logs/out.log',
      error_file: 'logs/error.log',
      time: true,
    },
  ],
};
