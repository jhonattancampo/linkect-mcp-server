#!/usr/bin/env node
/**
 * Linkect MCP Server
 *
 * Exposes Linkect scheduling data as Claude tools via the
 * Model Context Protocol (MCP). Connect it to Claude Desktop
 * to query your appointments and patients in natural language.
 *
 * Tools:
 *  - get_upcoming_appointments  → próximos turnos de un workspace
 *  - get_patient_summary        → historial de un paciente
 *  - get_daily_briefing         → resumen del día para el profesional
 *  - get_workspace_stats        → métricas generales del workspace
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { createClient } from '@supabase/supabase-js'
import { format, isToday, isTomorrow, formatDistanceToNow } from 'date-fns'
import { es } from 'date-fns/locale'
import { z } from 'zod'

// ── Supabase client ───────────────────────────────────────────

function getDB() {
  const url = process.env['SUPABASE_URL']
  const key = process.env['SUPABASE_SERVICE_ROLE_KEY']
  if (!url || !key) {
    throw new Error(
      'Missing env vars: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required'
    )
  }
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
}

// ── Tool input schemas ────────────────────────────────────────

const GetUpcomingAppointmentsSchema = z.object({
  workspace_slug: z.string().describe('The workspace slug (e.g. "dra-garcia")'),
  days_ahead: z
    .number()
    .int()
    .min(1)
    .max(30)
    .default(7)
    .describe('How many days ahead to look (default: 7)'),
})

const GetPatientSummarySchema = z.object({
  workspace_slug: z.string().describe('The workspace slug'),
  patient_email: z.string().email().describe("The patient's email address"),
})

const GetDailyBriefingSchema = z.object({
  workspace_slug: z.string().describe('The workspace slug'),
})

const GetWorkspaceStatsSchema = z.object({
  workspace_slug: z.string().describe('The workspace slug'),
})

// ── Helper: resolve workspace_id from slug ────────────────────

async function resolveWorkspaceId(slug: string): Promise<string> {
  const db = getDB()
  const { data, error } = await db
    .from('workspaces')
    .select('id, name')
    .eq('slug', slug)
    .single()

  if (error || !data) {
    throw new Error(`Workspace "${slug}" not found. Check the slug and try again.`)
  }
  return data.id
}

// ── Tool implementations ──────────────────────────────────────

async function getUpcomingAppointments(
  workspaceSlug: string,
  daysAhead: number
): Promise<string> {
  const db = getDB()
  const workspaceId = await resolveWorkspaceId(workspaceSlug)

  const from = new Date()
  const to = new Date()
  to.setDate(to.getDate() + daysAhead)

  const { data, error } = await db
    .from('appointments')
    .select(
      `
      id, starts_at, ends_at, status,
      patient:patients(full_name, email, phone),
      service:services(name, duration_minutes),
      payment:payments(status, amount, currency)
    `
    )
    .eq('workspace_id', workspaceId)
    .gte('starts_at', from.toISOString())
    .lte('starts_at', to.toISOString())
    .in('status', ['confirmed', 'pending_confirmation', 'pending_payment'])
    .order('starts_at', { ascending: true })

  if (error) throw new Error(`DB error: ${error.message}`)
  if (!data || data.length === 0) {
    return `No hay turnos programados para los próximos ${daysAhead} días en el workspace "${workspaceSlug}".`
  }

  const lines: string[] = [
    `📅 **Próximos turnos — ${workspaceSlug}** (${daysAhead} días)\n`,
  ]

  for (const appt of data) {
    const patient = appt.patient as unknown as { full_name: string; email: string; phone?: string } | null
    const service = appt.service as unknown as { name: string } | null
    const payment = appt.payment as unknown as { status: string; amount: number; currency: string }[] | null

    const startsAt = new Date(appt.starts_at as string)
    const endsAt = new Date(appt.ends_at as string)

    let dayLabel = format(startsAt, "EEEE d 'de' MMMM", { locale: es })
    if (isToday(startsAt)) dayLabel = '🟢 HOY'
    else if (isTomorrow(startsAt)) dayLabel = '🟡 MAÑANA'

    const timeRange = `${format(startsAt, 'HH:mm')} – ${format(endsAt, 'HH:mm')}`
    const patientName = patient?.full_name ?? 'Paciente desconocido'
    const serviceName = service?.name ?? 'Consulta'
    const paymentStatus = Array.isArray(payment) && payment.length > 0
      ? payment[0]?.status === 'approved' ? '✅ pagado' : '⏳ pago pendiente'
      : '—'

    lines.push(
      `**${dayLabel} · ${timeRange}**\n` +
      `  👤 ${patientName} (${patient?.email ?? ''})\n` +
      `  📋 ${serviceName} · ${appt.status}\n` +
      `  💳 ${paymentStatus}\n`
    )
  }

  lines.push(`\n_Total: ${data.length} turno(s)_`)
  return lines.join('\n')
}

async function getPatientSummary(
  workspaceSlug: string,
  patientEmail: string
): Promise<string> {
  const db = getDB()
  const workspaceId = await resolveWorkspaceId(workspaceSlug)

  // Find patient
  const { data: patient, error: pErr } = await db
    .from('patients')
    .select('id, full_name, email, phone, created_at')
    .eq('workspace_id', workspaceId)
    .ilike('email', patientEmail)
    .single()

  if (pErr || !patient) {
    return `No se encontró ningún paciente con email "${patientEmail}" en el workspace "${workspaceSlug}".`
  }

  // Get appointment history
  const { data: appointments } = await db
    .from('appointments')
    .select(`
      starts_at, ends_at, status,
      service:services(name),
      payment:payments(status, amount, currency),
      intake:intake_submissions(goal, activity_level, notes)
    `)
    .eq('workspace_id', workspaceId)
    .eq('patient_id', patient.id)
    .order('starts_at', { ascending: false })
    .limit(10)

  const memberSince = formatDistanceToNow(new Date(patient.created_at as string), {
    locale: es,
    addSuffix: true,
  })

  const lines: string[] = [
    `👤 **${patient.full_name}**`,
    `📧 ${patient.email}${patient.phone ? ` · 📱 ${patient.phone}` : ''}`,
    `🗓️ Paciente desde ${memberSince}\n`,
  ]

  if (!appointments || appointments.length === 0) {
    lines.push('_Sin historial de turnos._')
  } else {
    lines.push(`**Historial de turnos (últimos ${appointments.length}):**\n`)

    for (const appt of appointments) {
      const service = appt.service as unknown as { name: string } | null
      const payment = appt.payment as unknown as { status: string; amount: number; currency: string }[] | null
      const intake = appt.intake as unknown as { goal?: string; activity_level?: string; notes?: string } | null

      const date = format(new Date(appt.starts_at as string), "d MMM yyyy 'a las' HH:mm", { locale: es })
      const statusEmoji: Record<string, string> = {
        confirmed: '✅', completed: '✔️', cancelled: '❌',
        no_show: '🚫', pending_payment: '⏳', pending_confirmation: '🔔',
      }
      const emoji = statusEmoji[appt.status as string] ?? '📋'
      const paymentInfo = Array.isArray(payment) && payment.length > 0
        ? `${payment[0]?.amount} ${payment[0]?.currency} (${payment[0]?.status})`
        : '—'

      lines.push(`${emoji} **${date}** — ${service?.name ?? 'Consulta'} · ${appt.status}`)
      lines.push(`   💳 ${paymentInfo}`)

      if (intake?.goal) {
        lines.push(`   🎯 Objetivo: ${intake.goal}`)
      }
      if (intake?.notes) {
        lines.push(`   📝 ${intake.notes}`)
      }
      lines.push('')
    }
  }

  return lines.join('\n')
}

async function getDailyBriefing(workspaceSlug: string): Promise<string> {
  const db = getDB()
  const workspaceId = await resolveWorkspaceId(workspaceSlug)

  const todayStart = new Date()
  todayStart.setHours(0, 0, 0, 0)
  const todayEnd = new Date()
  todayEnd.setHours(23, 59, 59, 999)

  const { data: todayAppts } = await db
    .from('appointments')
    .select(`
      starts_at, ends_at, status,
      patient:patients(full_name, phone),
      service:services(name),
      payment:payments(status, amount, currency)
    `)
    .eq('workspace_id', workspaceId)
    .gte('starts_at', todayStart.toISOString())
    .lte('starts_at', todayEnd.toISOString())
    .order('starts_at', { ascending: true })

  // Tomorrow
  const tomorrowStart = new Date(todayStart)
  tomorrowStart.setDate(tomorrowStart.getDate() + 1)
  const tomorrowEnd = new Date(todayEnd)
  tomorrowEnd.setDate(tomorrowEnd.getDate() + 1)

  const { data: tomorrowAppts } = await db
    .from('appointments')
    .select('starts_at, ends_at, status, patient:patients(full_name)')
    .eq('workspace_id', workspaceId)
    .gte('starts_at', tomorrowStart.toISOString())
    .lte('starts_at', tomorrowEnd.toISOString())
    .in('status', ['confirmed', 'pending_confirmation'])
    .order('starts_at', { ascending: true })

  const today = format(new Date(), "EEEE d 'de' MMMM yyyy", { locale: es })
  const lines: string[] = [`# 📋 Briefing del día — ${today}\n`]

  // Today section
  const confirmedToday = (todayAppts ?? []).filter(
    (a) => a.status === 'confirmed' || a.status === 'pending_confirmation'
  )

  lines.push(`## Hoy tenés **${confirmedToday.length} turno(s)** confirmado(s)\n`)

  if (confirmedToday.length === 0) {
    lines.push('_Sin turnos para hoy._\n')
  } else {
    for (const appt of confirmedToday) {
      const patient = appt.patient as unknown as { full_name: string; phone?: string } | null
      const service = appt.service as unknown as { name: string } | null
      const payment = appt.payment as unknown as { status: string; amount: number; currency: string }[] | null
      const time = format(new Date(appt.starts_at as string), 'HH:mm')
      const paid = Array.isArray(payment) && payment[0]?.status === 'approved'
      lines.push(
        `⏰ **${time}** — ${patient?.full_name ?? 'Paciente'} · ${service?.name ?? 'Consulta'} ${paid ? '✅' : '⏳'}`
      )
      if (patient?.phone) lines.push(`   📱 ${patient.phone}`)
    }
    lines.push('')
  }

  // Pending payments today
  const pendingPayment = (todayAppts ?? []).filter((a) => a.status === 'pending_payment')
  if (pendingPayment.length > 0) {
    lines.push(`⚠️ **${pendingPayment.length} turno(s) con pago pendiente** para hoy\n`)
  }

  // Tomorrow preview
  lines.push(`## Mañana — ${(tomorrowAppts ?? []).length} turno(s)\n`)
  for (const appt of tomorrowAppts ?? []) {
    const patient = appt.patient as unknown as { full_name: string } | null
    const time = format(new Date(appt.starts_at as string), 'HH:mm')
    lines.push(`  • ${time} — ${patient?.full_name ?? 'Paciente'}`)
  }

  return lines.join('\n')
}

async function getWorkspaceStats(workspaceSlug: string): Promise<string> {
  const db = getDB()
  const workspaceId = await resolveWorkspaceId(workspaceSlug)

  const [{ count: totalPatients }, { count: totalAppointments }, { data: recentPayments }] =
    await Promise.all([
      db.from('patients').select('*', { count: 'exact', head: true }).eq('workspace_id', workspaceId),
      db.from('appointments').select('*', { count: 'exact', head: true }).eq('workspace_id', workspaceId),
      db
        .from('payments')
        .select('amount, currency, status, created_at')
        .eq('workspace_id', workspaceId)
        .eq('status', 'approved')
        .gte('created_at', new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()),
    ])

  const totalRevenue = (recentPayments ?? []).reduce((sum, p) => sum + Number(p.amount), 0)
  const currency = recentPayments?.[0]?.currency ?? 'ARS'

  const { data: statusBreakdown } = await db
    .from('appointments')
    .select('status')
    .eq('workspace_id', workspaceId)

  const statusCounts: Record<string, number> = {}
  for (const appt of statusBreakdown ?? []) {
    statusCounts[appt.status] = (statusCounts[appt.status] ?? 0) + 1
  }

  const lines = [
    `📊 **Stats — ${workspaceSlug}**\n`,
    `👥 Pacientes totales: **${totalPatients ?? 0}**`,
    `📅 Turnos totales: **${totalAppointments ?? 0}**`,
    `💰 Revenue últimos 30 días: **${totalRevenue.toLocaleString('es-AR')} ${currency}**\n`,
    `**Breakdown por estado:**`,
    ...Object.entries(statusCounts).map(([status, count]) => `  • ${status}: ${count}`),
  ]

  return lines.join('\n')
}

// ── MCP Server setup ──────────────────────────────────────────

const server = new Server(
  { name: 'linkect-mcp-server', version: '1.0.0' },
  { capabilities: { tools: {} } }
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'get_upcoming_appointments',
      description:
        'Get upcoming appointments for a Linkect workspace. Returns patient names, times, service types, and payment status.',
      inputSchema: {
        type: 'object',
        properties: {
          workspace_slug: { type: 'string', description: 'The workspace slug (e.g. "dra-garcia")' },
          days_ahead: { type: 'number', description: 'Days ahead to look (default: 7, max: 30)', default: 7 },
        },
        required: ['workspace_slug'],
      },
    },
    {
      name: 'get_patient_summary',
      description:
        "Get a patient's full history within a workspace: appointment history, intake goals, and payment records.",
      inputSchema: {
        type: 'object',
        properties: {
          workspace_slug: { type: 'string', description: 'The workspace slug' },
          patient_email: { type: 'string', description: "Patient's email address" },
        },
        required: ['workspace_slug', 'patient_email'],
      },
    },
    {
      name: 'get_daily_briefing',
      description:
        "Generate a professional daily briefing for the workspace: today's appointments, pending payments, and tomorrow's preview.",
      inputSchema: {
        type: 'object',
        properties: {
          workspace_slug: { type: 'string', description: 'The workspace slug' },
        },
        required: ['workspace_slug'],
      },
    },
    {
      name: 'get_workspace_stats',
      description:
        'Get aggregate stats for a workspace: total patients, appointments, revenue last 30 days, and appointment status breakdown.',
      inputSchema: {
        type: 'object',
        properties: {
          workspace_slug: { type: 'string', description: 'The workspace slug' },
        },
        required: ['workspace_slug'],
      },
    },
  ],
}))

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params

  try {
    let result: string

    switch (name) {
      case 'get_upcoming_appointments': {
        const { workspace_slug, days_ahead } = GetUpcomingAppointmentsSchema.parse(args)
        result = await getUpcomingAppointments(workspace_slug, days_ahead ?? 7)
        break
      }
      case 'get_patient_summary': {
        const { workspace_slug, patient_email } = GetPatientSummarySchema.parse(args)
        result = await getPatientSummary(workspace_slug, patient_email)
        break
      }
      case 'get_daily_briefing': {
        const { workspace_slug } = GetDailyBriefingSchema.parse(args)
        result = await getDailyBriefing(workspace_slug)
        break
      }
      case 'get_workspace_stats': {
        const { workspace_slug } = GetWorkspaceStatsSchema.parse(args)
        result = await getWorkspaceStats(workspace_slug)
        break
      }
      default:
        throw new Error(`Unknown tool: ${name}`)
    }

    return { content: [{ type: 'text', text: result }] }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      content: [{ type: 'text', text: `Error: ${message}` }],
      isError: true,
    }
  }
})

// ── Start ─────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error('Linkect MCP Server running on stdio')
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
