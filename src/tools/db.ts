import { createClient } from '@supabase/supabase-js'

if (typeof globalThis.WebSocket === 'undefined') {
  const { default: ws } = await import('ws')
  globalThis.WebSocket = ws as unknown as typeof WebSocket
}


export function getDB() {
  const url = process.env['SUPABASE_URL']
  const key = process.env['SUPABASE_SERVICE_ROLE_KEY']
  if (!url || !key) {
    throw new Error('Missing env vars: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required')
  }
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: {
      fetch: fetch,
    },
    realtime: {
      params: { eventsPerSecond: 0 },
    },
  })
}
export async function resolveWorkspaceId(slug: string): Promise<{ id: string; name: string }> {
  const db = getDB()
  const { data, error } = await db
    .from('workspaces')
    .select('id, name')
    .eq('slug', slug)
    .single()
  if (error || !data) throw new Error(`Workspace "${slug}" not found.`)
  return data as { id: string; name: string }
}
