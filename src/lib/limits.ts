import type { Env } from '../env'

/** Counts one hit against `key`; false once more than `limit` hits land in the current window. */
export async function underLimit(env: Env, key: string, limit: number, windowMs: number): Promise<boolean> {
  const now = Date.now()
  const row = await env.DB.prepare(
    `INSERT INTO rate_limits (key, count, reset_at) VALUES (?1, 1, ?2)
     ON CONFLICT (key) DO UPDATE SET
       count = CASE WHEN reset_at <= ?3 THEN 1 ELSE count + 1 END,
       reset_at = CASE WHEN reset_at <= ?3 THEN ?2 ELSE reset_at END
     RETURNING count`,
  )
    .bind(key, now + windowMs, now)
    .first<{ count: number }>()
  return (row?.count ?? 1) <= limit
}
