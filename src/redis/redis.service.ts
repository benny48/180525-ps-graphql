import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Redis, Pipeline } from 'ioredis';

export interface RedisMetrics {
  totalCommands: number;
  successfulCommands: number;
  failedCommands: number;
  connectionStatus: string;
  uptime: number;
}

@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private readonly redisClient: Redis;
  private readonly metricsStartTime: number;
  private commandCount: number = 0;
  private successCount: number = 0;
  private failedCount: number = 0;

  constructor() {
    const host = process.env.REDIS_HOST || 'localhost';
    const port = parseInt(process.env.REDIS_PORT || '6379');
    const db = parseInt(process.env.REDIS_DB || '0');
    const maxRetriesPerRequest = parseInt(process.env.REDIS_MAX_RETRIES || '3');
    const connectTimeout = parseInt(
      process.env.REDIS_CONNECT_TIMEOUT || '10000',
    );
    const commandTimeout = parseInt(
      process.env.REDIS_COMMAND_TIMEOUT || '5000',
    );

    this.logger.log(
      `📌 Menginisialisasi koneksi Redis: ${host}:${port} (DB: ${db})`,
    );

    this.redisClient = new Redis({
      host,
      port,
      password: process.env.REDIS_PASSWORD,
      db,
      maxRetriesPerRequest,
      connectTimeout,
      commandTimeout,
      retryStrategy: (times) => {
        const delay = Math.min(times * 100, 3000);
        this.logger.warn(
          `⚠️ Redis koneksi gagal, mencoba ulang dalam ${delay}ms... (attempt: ${times})`,
        );
        return delay;
      },
      reconnectOnError: (err) => {
        const targetError = 'READONLY';
        return err.message.includes(targetError);
      },
      // Connection pool settings
      lazyConnect: true,
      keepAlive: 30000,
      family: 4,
    });

    this.metricsStartTime = Date.now();

    // Event listeners
    this.redisClient.on('connect', () => {
      this.logger.log('✅ Redis terhubung berhasil');
    });

    this.redisClient.on('ready', () => {
      this.logger.log('🚀 Redis ready untuk menerima commands');
    });

    this.redisClient.on('error', (err) => {
      this.logger.error(`❌ Redis error: ${err.message}`, err.stack);
      this.failedCount++;
    });

    this.redisClient.on('close', () => {
      this.logger.warn('⚠️ Redis connection closed');
    });

    this.redisClient.on('reconnecting', () => {
      this.logger.log('🔄 Redis reconnecting...');
    });

    // Command monitoring
    this.redisClient.on('sent', () => {
      this.commandCount++;
    });

    this.redisClient.on('reply', () => {
      this.successCount++;
    });
  }

  async onModuleDestroy() {
    await this.disconnect();
  }

  async disconnect(): Promise<void> {
    try {
      await this.redisClient.quit();
      this.logger.log('🔌 Redis connection closed cleanly');
    } catch (error) {
      this.logger.error(`❌ Error closing Redis connection: ${error.message}`);
    }
  }

  // Health check
  async ping(): Promise<boolean> {
    try {
      const result = await this.redisClient.ping();
      return result === 'PONG';
    } catch (error) {
      this.logger.error(`❌ Redis ping failed: ${error.message}`);
      return false;
    }
  }

  // Get Redis info
  async getInfo(): Promise<any> {
    try {
      const info = await this.redisClient.info();
      return this.parseInfo(info);
    } catch (error) {
      this.logger.error(`❌ Redis info error: ${error.message}`);
      return null;
    }
  }

  private parseInfo(info: string): any {
    const parsed: any = {};
    const sections = info.split('\r\n');

    let currentSection = '';
    for (const line of sections) {
      if (line.startsWith('#')) {
        currentSection = line.substring(2).toLowerCase();
        parsed[currentSection] = {};
      } else if (line.includes(':')) {
        const [key, value] = line.split(':');
        if (currentSection) {
          parsed[currentSection][key] = value;
        }
      }
    }

    return parsed;
  }

  // Basic operations with enhanced error handling
  async get(key: string): Promise<string | null> {
    try {
      const result = await this.redisClient.get(key);
      if (result) {
        this.logger.debug(`📖 Redis GET: ${key} (${result.length} bytes)`);
      } else {
        this.logger.debug(`📖 Redis GET: ${key} (cache miss)`);
      }
      return result;
    } catch (error) {
      this.logger.error(
        `❌ Redis GET error untuk key ${key}: ${error.message}`,
      );
      throw error; // Rethrow untuk error handling di level atas
    }
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    try {
      if (ttlSeconds) {
        await this.redisClient.set(key, value, 'EX', ttlSeconds);
        this.logger.debug(
          `📝 Redis SET: ${key} (${value.length} bytes, TTL: ${ttlSeconds}s)`,
        );
      } else {
        await this.redisClient.set(key, value);
        this.logger.debug(
          `📝 Redis SET: ${key} (${value.length} bytes, no TTL)`,
        );
      }
    } catch (error) {
      this.logger.error(
        `❌ Redis SET error untuk key ${key}: ${error.message}`,
      );
      throw error;
    }
  }

  async del(key: string | string[]): Promise<number> {
    try {
      if (Array.isArray(key)) {
        if (key.length === 0) return 0;
        const result = await this.redisClient.del(...key);
        this.logger.debug(
          `🗑️ Redis DEL: ${key.length} keys (${result} keys removed)`,
        );
        return result;
      } else {
        const result = await this.redisClient.del(key);
        this.logger.debug(`🗑️ Redis DEL: ${key} (${result} keys removed)`);
        return result;
      }
    } catch (error) {
      this.logger.error(`❌ Redis DEL error: ${error.message}`);
      throw error;
    }
  }

  async keys(pattern: string): Promise<string[]> {
    try {
      const keys = await this.redisClient.keys(pattern);
      this.logger.debug(
        `🔍 Redis KEYS: ${pattern} (${keys.length} keys found)`,
      );
      return keys;
    } catch (error) {
      this.logger.error(
        `❌ Redis KEYS error untuk pattern ${pattern}: ${error.message}`,
      );
      throw error;
    }
  }

  // Hash operations
  async hget(key: string, field: string): Promise<string | null> {
    try {
      const result = await this.redisClient.hget(key, field);
      this.logger.debug(
        `📖 Redis HGET: ${key}.${field} (${result ? 'found' : 'not found'})`,
      );
      return result;
    } catch (error) {
      this.logger.error(
        `❌ Redis HGET error untuk ${key}.${field}: ${error.message}`,
      );
      throw error;
    }
  }

  async hset(key: string, field: string, value: string): Promise<number> {
    try {
      const result = await this.redisClient.hset(key, field, value);
      this.logger.debug(
        `📝 Redis HSET: ${key}.${field} (${value.length} bytes)`,
      );
      return result;
    } catch (error) {
      this.logger.error(
        `❌ Redis HSET error untuk ${key}.${field}: ${error.message}`,
      );
      throw error;
    }
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    try {
      const result = await this.redisClient.hgetall(key);
      const fieldCount = Object.keys(result).length;
      this.logger.debug(`📖 Redis HGETALL: ${key} (${fieldCount} fields)`);
      return result;
    } catch (error) {
      this.logger.error(
        `❌ Redis HGETALL error untuk key ${key}: ${error.message}`,
      );
      throw error;
    }
  }

  async hincrby(
    key: string,
    field: string,
    increment: number,
  ): Promise<number> {
    try {
      const result = await this.redisClient.hincrby(key, field, increment);
      this.logger.debug(
        `📈 Redis HINCRBY: ${key}.${field} +${increment} = ${result}`,
      );
      return result;
    } catch (error) {
      this.logger.error(
        `❌ Redis HINCRBY error untuk ${key}.${field}: ${error.message}`,
      );
      throw error;
    }
  }

  async hdel(key: string, ...fields: string[]): Promise<number> {
    try {
      const result = await this.redisClient.hdel(key, ...fields);
      this.logger.debug(
        `🗑️ Redis HDEL: ${key} fields [${fields.join(', ')}] (${result} removed)`,
      );
      return result;
    } catch (error) {
      this.logger.error(
        `❌ Redis HDEL error untuk key ${key}: ${error.message}`,
      );
      throw error;
    }
  }

  // TTL operations
  async expire(key: string, seconds: number): Promise<number> {
    try {
      const result = await this.redisClient.expire(key, seconds);
      this.logger.debug(`⏰ Redis EXPIRE: ${key} TTL set to ${seconds}s`);
      return result;
    } catch (error) {
      this.logger.error(
        `❌ Redis EXPIRE error untuk key ${key}: ${error.message}`,
      );
      throw error;
    }
  }

  async ttl(key: string): Promise<number> {
    try {
      const result = await this.redisClient.ttl(key);
      this.logger.debug(`⏰ Redis TTL: ${key} = ${result}s`);
      return result;
    } catch (error) {
      this.logger.error(
        `❌ Redis TTL error untuk key ${key}: ${error.message}`,
      );
      throw error;
    }
  }

  // Atomic operations
  async watch(...keys: string[]): Promise<string> {
    try {
      const result = await this.redisClient.watch(...keys);
      this.logger.debug(`👀 Redis WATCH: [${keys.join(', ')}]`);
      return result;
    } catch (error) {
      this.logger.error(
        `❌ Redis WATCH error untuk keys [${keys.join(', ')}]: ${error.message}`,
      );
      throw error;
    }
  }

  async unwatch(): Promise<string> {
    try {
      const result = await this.redisClient.unwatch();
      this.logger.debug(`👀 Redis UNWATCH: all keys unwatched`);
      return result;
    } catch (error) {
      this.logger.error(`❌ Redis UNWATCH error: ${error.message}`);
      throw error;
    }
  }

  // Transaction operations
  multi(): import('ioredis').ChainableCommander {
    this.logger.debug(`🔄 Redis MULTI: Starting transaction`);
    return this.redisClient.multi();
  }

  // Pipeline operations
  pipeline(): import('ioredis').ChainableCommander {
    this.logger.debug(`📦 Redis PIPELINE: Starting pipeline`);
    return this.redisClient.pipeline();
  }

  // List operations
  async lpush(key: string, ...values: string[]): Promise<number> {
    try {
      const result = await this.redisClient.lpush(key, ...values);
      this.logger.debug(
        `📝 Redis LPUSH: ${key} (${values.length} values, list size: ${result})`,
      );
      return result;
    } catch (error) {
      this.logger.error(
        `❌ Redis LPUSH error untuk key ${key}: ${error.message}`,
      );
      throw error;
    }
  }

  async lrange(key: string, start: number, stop: number): Promise<string[]> {
    try {
      const result = await this.redisClient.lrange(key, start, stop);
      this.logger.debug(
        `📖 Redis LRANGE: ${key}[${start}:${stop}] (${result.length} items)`,
      );
      return result;
    } catch (error) {
      this.logger.error(
        `❌ Redis LRANGE error untuk key ${key}: ${error.message}`,
      );
      throw error;
    }
  }

  // Set operations
  async sadd(key: string, ...members: string[]): Promise<number> {
    try {
      const result = await this.redisClient.sadd(key, ...members);
      this.logger.debug(
        `📝 Redis SADD: ${key} (${members.length} members, ${result} added)`,
      );
      return result;
    } catch (error) {
      this.logger.error(
        `❌ Redis SADD error untuk key ${key}: ${error.message}`,
      );
      throw error;
    }
  }

  async smembers(key: string): Promise<string[]> {
    try {
      const result = await this.redisClient.smembers(key);
      this.logger.debug(`📖 Redis SMEMBERS: ${key} (${result.length} members)`);
      return result;
    } catch (error) {
      this.logger.error(
        `❌ Redis SMEMBERS error untuk key ${key}: ${error.message}`,
      );
      throw error;
    }
  }

  // Increment operations
  async incr(key: string): Promise<number> {
    try {
      const result = await this.redisClient.incr(key);
      this.logger.debug(`📈 Redis INCR: ${key} = ${result}`);
      return result;
    } catch (error) {
      this.logger.error(
        `❌ Redis INCR error untuk key ${key}: ${error.message}`,
      );
      throw error;
    }
  }

  async incrby(key: string, increment: number): Promise<number> {
    try {
      const result = await this.redisClient.incrby(key, increment);
      this.logger.debug(`📈 Redis INCRBY: ${key} +${increment} = ${result}`);
      return result;
    } catch (error) {
      this.logger.error(
        `❌ Redis INCRBY error untuk key ${key}: ${error.message}`,
      );
      throw error;
    }
  }

  async decr(key: string): Promise<number> {
    try {
      const result = await this.redisClient.decr(key);
      this.logger.debug(`📉 Redis DECR: ${key} = ${result}`);
      return result;
    } catch (error) {
      this.logger.error(
        `❌ Redis DECR error untuk key ${key}: ${error.message}`,
      );
      throw error;
    }
  }

  // Existence check
  async exists(...keys: string[]): Promise<number> {
    try {
      const result = await this.redisClient.exists(...keys);
      this.logger.debug(
        `🔍 Redis EXISTS: [${keys.join(', ')}] (${result} exist)`,
      );
      return result;
    } catch (error) {
      this.logger.error(
        `❌ Redis EXISTS error untuk keys [${keys.join(', ')}]: ${error.message}`,
      );
      throw error;
    }
  }

  // Utility operations
  async flushAll(): Promise<void> {
    try {
      await this.redisClient.flushall();
      this.logger.warn('⚠️ Redis FLUSHALL: Semua data cache dihapus');
    } catch (error) {
      this.logger.error(`❌ Redis FLUSHALL error: ${error.message}`);
      throw error;
    }
  }

  async flushdb(): Promise<void> {
    try {
      await this.redisClient.flushdb();
      this.logger.warn(
        `⚠️ Redis FLUSHDB: Database ${this.redisClient.options.db} dihapus`,
      );
    } catch (error) {
      this.logger.error(`❌ Redis FLUSHDB error: ${error.message}`);
      throw error;
    }
  }

  // Memory analysis
  async memoryUsage(key: string): Promise<number | null> {
    try {
      const result = await this.redisClient.memory('USAGE', key);
      this.logger.debug(`💾 Redis MEMORY USAGE: ${key} = ${result} bytes`);
      return result;
    } catch (error) {
      this.logger.error(
        `❌ Redis MEMORY USAGE error untuk key ${key}: ${error.message}`,
      );
      return null;
    }
  }

  // Get metrics
  getMetrics(): RedisMetrics {
    const uptime = Date.now() - this.metricsStartTime;
    const status = this.redisClient.status;

    return {
      totalCommands: this.commandCount,
      successfulCommands: this.successCount,
      failedCommands: this.failedCount,
      connectionStatus: status,
      uptime: Math.floor(uptime / 1000), // in seconds
    };
  }

  // Reset metrics
  resetMetrics(): void {
    this.commandCount = 0;
    this.successCount = 0;
    this.failedCount = 0;
    this.logger.log('📊 Redis metrics reset');
  }

  // Get connection status
  getConnectionStatus(): string {
    return this.redisClient.status;
  }

  // Scan operations for large datasets
  async scan(
    cursor: number,
    pattern?: string,
    count?: number,
  ): Promise<[string, string[]]> {
    try {
      const args: Array<string | number> = [cursor.toString()];

      if (pattern) {
        args.push('MATCH', pattern);
      }

      if (count) {
        args.push('COUNT', count);
      }

      const result = await this.redisClient.scan(
        ...(args as [string, ...any[]]),
      );
      this.logger.debug(
        `🔍 Redis SCAN: cursor=${cursor}, pattern=${pattern || '*'}, found=${result[1].length} keys`,
      );
      return result;
    } catch (error) {
      this.logger.error(`❌ Redis SCAN error: ${error.message}`);
      throw error;
    }
  }

  // Batch operations with better error handling
  async batchSet(
    keyValues: Array<{ key: string; value: string; ttl?: number }>,
  ): Promise<number> {
    if (keyValues.length === 0) return 0;

    const pipeline = this.pipeline();

    keyValues.forEach(({ key, value, ttl }) => {
      if (ttl) {
        pipeline.set(key, value, 'EX', ttl);
      } else {
        pipeline.set(key, value);
      }
    });

    try {
      const results = await pipeline.exec();
      const successCount = results?.filter(([err]) => !err).length || 0;

      this.logger.debug(
        `📦 Redis BATCH SET: ${successCount}/${keyValues.length} keys set successfully`,
      );

      return successCount;
    } catch (error) {
      this.logger.error(`❌ Redis BATCH SET error: ${error.message}`);
      throw error;
    }
  }

  async batchGet(keys: string[]): Promise<(string | null)[]> {
    if (keys.length === 0) return [];

    try {
      const results = await this.redisClient.mget(...keys);
      const foundCount = results.filter((result) => result !== null).length;

      this.logger.debug(
        `📦 Redis BATCH GET: ${foundCount}/${keys.length} keys found`,
      );

      return results;
    } catch (error) {
      this.logger.error(`❌ Redis BATCH GET error: ${error.message}`);
      throw error;
    }
  }

  // Get raw Redis client (for advanced operations)
  getClient(): Redis {
    return this.redisClient;
  }
}
