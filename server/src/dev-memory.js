import { MongoMemoryReplSet } from 'mongodb-memory-server';

const replSet = await MongoMemoryReplSet.create({
  replSet: { count: 1, storageEngine: 'wiredTiger' },
});
process.env.MONGODB_URI = replSet.getUri('darkmedia');
console.log('Temporary MongoDB replica set is running. Data disappears when this process stops.');

await import('./index.js');

async function stop() {
  await replSet.stop();
  process.exit(0);
}

process.on('SIGINT', stop);
process.on('SIGTERM', stop);
