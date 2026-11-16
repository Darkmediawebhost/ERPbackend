import compression from 'compression';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import mongoose from 'mongoose';
import morgan from 'morgan';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { connectDatabase } from './db.js';
import { errorMiddleware } from './http.js';
import { startJobs } from './jobs.js';
import api from './routes/index.js';
import { ensureFoundation } from './seed.js';

const app = express();
if (config.trustProxy) app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(cors({ origin: config.clientOrigin, credentials: true }));
app.use(compression());
app.use(cookieParser());
app.use(express.json({ limit: '1mb' }));
if (!config.production) app.use(morgan('dev'));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'darkmedia-erp' });
});
app.use('/api', api);
app.use(errorMiddleware);

const clientDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../client/dist');
app.use(express.static(clientDist));
app.use((req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  res.sendFile(path.join(clientDist, 'index.html'), (error) => {
    if (error) res.status(404).json({ error: 'Not found' });
  });
});

await connectDatabase();
await useDevelopmentReplicaSet();
await ensureFoundation();
startJobs();
const server = app.listen(config.port, () => {
  console.log(`Dark Media ERP API listening on http://localhost:${config.port}`);
});
server.on('error', (error) => {
  if (error?.code === 'EADDRINUSE') {
    console.error(`Port ${config.port} is already in use. Stop the other API process and start this one again.`);
    process.exit(1);
  }
  throw error;
});

async function useDevelopmentReplicaSet() {
  if (config.production) return;
  let replica = false;
  try {
    const hello = await mongoose.connection.db.admin().command({ hello: 1 });
    replica = Boolean(hello.setName);
  } catch {
    replica = false;
  }
  if (replica) return;
  console.log('The configured MongoDB is not a replica set. Starting a temporary development database. Saved data disappears when this API stops.');
  await mongoose.disconnect();
  if (!process.env.MONGOMS_DOWNLOAD_DIR) process.env.MONGOMS_DOWNLOAD_DIR = 'D:\\mongo-binaries';
  const { MongoMemoryReplSet } = await import('mongodb-memory-server');
  const replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  config.mongoUri = replSet.getUri('darkmedia');
  const stop = async () => {
    await replSet.stop().catch(() => undefined);
    process.exit(0);
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  await connectDatabase();
}
