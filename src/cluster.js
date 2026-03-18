'use strict';

require('dotenv').config();

const cluster = require('cluster');
const os      = require('os');
const logger  = require('./utils/logger');

const NUM_WORKERS = parseInt(process.env.CLUSTER_WORKERS || String(os.cpus().length), 10);

if (cluster.isPrimary) {
  logger.info(`Primary [PID: ${process.pid}] forking ${NUM_WORKERS} workers`);
  logger.info(`Host: ${os.cpus().length} CPUs | ${Math.round(os.totalmem() / 1024 / 1024)} MB RAM`);

  const metrics = new Map();

  for (let i = 0; i < NUM_WORKERS; i++) {
    const w = cluster.fork({ WORKER_ID: i + 1 });
    metrics.set(w.id, { startTime: Date.now(), restarts: 0 });
    logger.info(`Worker ${i + 1} forked [PID: ${w.process.pid}]`);
  }

  cluster.on('exit', (worker, code, signal) => {
    const m = metrics.get(worker.id) || { restarts: 0 };
    logger.warn(`Worker ${worker.id} died [code:${code}] [signal:${signal}] restarts:${m.restarts}`);

    if (!worker.exitedAfterDisconnect) {
      setTimeout(() => {
        const nw = cluster.fork({ WORKER_ID: worker.id });
        metrics.set(nw.id, { startTime: Date.now(), restarts: m.restarts + 1 });
        logger.info(`Worker restarted [PID: ${nw.process.pid}]`);
      }, 1000);
    }
  });

  // Health ping every 30s
  const hb = setInterval(() => {
    const alive = Object.values(cluster.workers || {}).length;
    logger.info(`Cluster: ${alive}/${NUM_WORKERS} workers alive`);
    Object.values(cluster.workers || {}).forEach(w => w.send({ type: 'PING' }));
  }, 30_000);

  const shutdown = (sig) => {
    logger.info(`Primary ${sig} — shutting cluster down`);
    clearInterval(hb);
    Object.values(cluster.workers || {}).forEach(w => {
      w.send({ type: 'SHUTDOWN' });
      w.disconnect();
      setTimeout(() => { if (!w.isDead()) w.kill(); }, 15_000);
    });
    setTimeout(() => process.exit(0), 20_000);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));

} else {
  logger.info(`Worker ${process.env.WORKER_ID} starting [PID: ${process.pid}]`);
  require('./server');

  process.on('message', (msg) => {
    if (msg.type === 'PING') {
      process.send({
        type: 'PONG',
        memory: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
        uptime: Math.floor(process.uptime()),
      });
    }
  });
}
