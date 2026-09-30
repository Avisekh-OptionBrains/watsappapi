import IORedis from 'ioredis'
import { config } from '../config'

let client: IORedis | null = null

export function getRedis(): IORedis {
  if (!client) {
    client = new IORedis(config.redisUrl, {
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
    })
  }
  return client
}

export async function closeRedis(): Promise<void> {
  if (!client) return
  await client.quit()
  client = null
}

