/**
 * Linkect MCP — HTTP Server
 *
 * Exposes the same tools as the MCP server via a REST API,
 * with a mobile-first web UI served from /public.
 *
 * Routes:
 *   GET  /api/appointments?slug=&days=
 *   GET  /api/briefing?slug=
 *   GET  /api/stats?slug=
 *   GET  /api/patient?slug=&email=
 *   GET  /health
 */
import 'dotenv/config'
import express from 'express'
import path from 'path'
import { fileURLToPath } from 'url'
import {
  getUpcomingAppointments,
  getDailyBriefing,
  getWorkspaceStats,
  getPatientSummary,
} from './tools/appointments.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = express()
const PORT = process.env['PORT'] ?? 3105

app.use(express.json())
app.use(express.static(path.join(__dirname, '..', 'public')))

// ── Health ────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'linkect-mcp-server', version: '1.0.0' })
})

// ── API helper ────────────────────────────────────────────────
function asyncHandler(
  fn: (req: express.Request, res: express.Response) => Promise<void>
) {
  return (req: express.Request, res: express.Response) => {
    fn(req, res).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err)
      res.status(400).json({ error: message })
    })
  }
}

// ── Upcoming appointments ─────────────────────────────────────
app.get(
  '/api/appointments',
  asyncHandler(async (req, res) => {
    const slug = String(req.query['slug'] ?? '')
    const days = Math.min(30, Math.max(1, Number(req.query['days'] ?? 7)))
    if (!slug) { res.status(400).json({ error: 'slug is required' }); return }
    const data = await getUpcomingAppointments(slug, days)
    res.json(data)
  })
)

// ── Daily briefing ────────────────────────────────────────────
app.get(
  '/api/briefing',
  asyncHandler(async (req, res) => {
    const slug = String(req.query['slug'] ?? '')
    if (!slug) { res.status(400).json({ error: 'slug is required' }); return }
    const data = await getDailyBriefing(slug)
    res.json(data)
  })
)

// ── Workspace stats ───────────────────────────────────────────
app.get(
  '/api/stats',
  asyncHandler(async (req, res) => {
    const slug = String(req.query['slug'] ?? '')
    if (!slug) { res.status(400).json({ error: 'slug is required' }); return }
    const data = await getWorkspaceStats(slug)
    res.json(data)
  })
)

// ── Patient summary ───────────────────────────────────────────
app.get(
  '/api/patient',
  asyncHandler(async (req, res) => {
    const slug = String(req.query['slug'] ?? '')
    const email = String(req.query['email'] ?? '')
    if (!slug || !email) { res.status(400).json({ error: 'slug and email are required' }); return }
    const data = await getPatientSummary(slug, email)
    res.json(data)
  })
)

app.listen(PORT, () => {
  console.log(`Linkect MCP HTTP server running at http://localhost:${PORT}`)
})

export default app
