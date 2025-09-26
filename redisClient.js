// server/redisClient.js
import * as dotenv from 'dotenv';
import { createClient } from 'redis';

dotenv.config();

const REDIS_URL = process.env.REDIS_URL || null;

let redisClient = null;

if (REDIS_URL) {
  // create client and connect; supports rediss:// (TLS) for Upstash
  redisClient = createClient({ url: REDIS_URL });
  redisClient.on('error', (err) => console.error('Redis error', err));
  // top-level await is allowed in ESM; wrap in IIFE for safety
  (async () => {
    try {
      await redisClient.connect();
      console.log('Redis connected');
    } catch (e) {
      console.error('Redis connect failed:', e);
      redisClient = null;
    }
  })();
} else {
  console.log('No REDIS_URL provided — running without Redis (ephemeral in-memory queues)');
}

export default redisClient;
