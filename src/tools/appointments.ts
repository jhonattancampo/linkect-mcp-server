import { format, isToday, isTomorrow } from 'date-fns'
import { es } from 'date-fns/locale'
import { getDB, resolveWorkspaceId } from './db.js'

export async function getUpcomingAppointments(workspaceSlug: string, daysAhead: number) {
  const db = getDB()
  const workspace = await resolveWorkspaceId(workspaceSlug)

  const from = new Date()
  const to = new Date()
  to.setDate(to.getDate() + daysAhead)

  const { data, error } = await db
    .from('appointments')
    .select(`
      id, starts_at, ends_at, status,
      patient:patients(full_name, email, phone),
      service:services(name, duration_minutes),
      payment:payments(status, amount, currency)
    `)
    .eq('workspace_id', workspace.id)
    .gte('starts_at', from.toISOString())
    .lte('starts_at', to.toISOString())
    .in('status', ['confirmed', 'pending_confirmation', 'pending_payment'])
    .order('starts_at', { ascending: true })

  if (error) throw new Error(`DB error: ${error.message}`)

  return {
    workspace: workspace.name,
    slug: workspaceSlug,
    daysAhead,
    total: (data ?? []).length,
    appointments: (data ?? []).map((appt) => {
      const patient = appt.patient as unknown as { full_name: string; email: string; phone?: string } | null
      const service = appt.service as unknown as { name: string } | null
      const payment = appt.payment as unknown as { status: string; amount: number; currency: string }[] | null
      const startsAt = new Date(appt.starts_at as string)
      const endsAt = new Date(appt.ends_at as string)

      let dayLabel = format(startsAt, "EEEE d 'de' MMMM", { locale: es })
      if (isToday(startsAt)) dayLabel = 'Hoy'
      else if (isTomorrow(startsAt)) dayLabel = 'Mañana'

      return {
        id: appt.id,
        dayLabel,
        time: `${format(startsAt, 'HH:mm')} – ${format(endsAt, 'HH:mm')}`,
        startsAt: startsAt.toISOString(),
        status: appt.status,
        patient: {
          name: patient?.full_name ?? 'Paciente',
          email: patient?.email ?? '',
          phone: patient?.phone ?? null,
        },
        service: service?.name ?? 'Consulta',
        payment: Array.isArray(payment) && payment.length > 0
          ? { status: payment[0]?.status, amount: payment[0]?.amount, currency: payment[0]?.currency }
          : null,
      }
    }),
  }
}

export async function getDailyBriefing(workspaceSlug: string) {
  const db = getDB()
  const workspace = await resolveWorkspaceId(workspaceSlug)

  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0)
  const todayEnd = new Date(); todayEnd.setHours(23, 59, 59, 999)
  const tomorrowStart = new Date(todayStart); tomorrowStart.setDate(tomorrowStart.getDate() + 1)
  const tomorrowEnd = new Date(todayEnd); tomorrowEnd.setDate(tomorrowEnd.getDate() + 1)

  const [{ data: todayAppts }, { data: tomorrowAppts }] = await Promise.all([
    db.from('appointments')
      .select(`starts_at, ends_at, status, patient:patients(full_name, phone), service:services(name), payment:payments(status, amount, currency)`)
      .eq('workspace_id', workspace.id)
      .gte('starts_at', todayStart.toISOString())
      .lte('starts_at', todayEnd.toISOString())
      .order('starts_at', { ascending: true }),
    db.from('appointments')
      .select(`starts_at, status, patient:patients(full_name)`)
      .eq('workspace_id', workspace.id)
      .gte('starts_at', tomorrowStart.toISOString())
      .lte('starts_at', tomorrowEnd.toISOString())
      .in('status', ['confirmed', 'pending_confirmation'])
      .order('starts_at', { ascending: true }),
  ])

  const confirmed = (todayAppts ?? []).filter(a => ['confirmed', 'pending_confirmation'].includes(a.status as string))
  const pendingPayment = (todayAppts ?? []).filter(a => a.status === 'pending_payment')

  return {
    workspace: workspace.name,
    slug: workspaceSlug,
    date: format(new Date(), "EEEE d 'de' MMMM yyyy", { locale: es }),
    today: confirmed.map(appt => {
      const patient = appt.patient as unknown as { full_name: string; phone?: string } | null
      const service = appt.service as unknown as { name: string } | null
      const payment = appt.payment as unknown as { status: string; amount: number; currency: string }[] | null
      return {
        time: format(new Date(appt.starts_at as string), 'HH:mm'),
        patient: patient?.full_name ?? 'Paciente',
        phone: patient?.phone ?? null,
        service: service?.name ?? 'Consulta',
        paid: Array.isArray(payment) && payment[0]?.status === 'approved',
        status: appt.status,
      }
    }),
    pendingPaymentCount: pendingPayment.length,
    tomorrow: (tomorrowAppts ?? []).map(appt => {
      const patient = appt.patient as unknown as { full_name: string } | null
      return {
        time: format(new Date(appt.starts_at as string), 'HH:mm'),
        patient: patient?.full_name ?? 'Paciente',
      }
    }),
  }
}

export async function getWorkspaceStats(workspaceSlug: string) {
  const db = getDB()
  const workspace = await resolveWorkspaceId(workspaceSlug)

  const [
    { count: totalPatients },
    { count: totalAppointments },
    { data: recentPayments },
    { data: statusBreakdown },
  ] = await Promise.all([
    db.from('patients').select('*', { count: 'exact', head: true }).eq('workspace_id', workspace.id),
    db.from('appointments').select('*', { count: 'exact', head: true }).eq('workspace_id', workspace.id),
    db.from('payments').select('amount, currency, status').eq('workspace_id', workspace.id).eq('status', 'approved')
      .gte('created_at', new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()),
    db.from('appointments').select('status').eq('workspace_id', workspace.id),
  ])

  const totalRevenue = (recentPayments ?? []).reduce((sum, p) => sum + Number(p.amount), 0)
  const currency = recentPayments?.[0]?.currency ?? 'ARS'
  const statusCounts: Record<string, number> = {}
  for (const appt of statusBreakdown ?? []) {
    statusCounts[appt.status as string] = (statusCounts[appt.status as string] ?? 0) + 1
  }

  return {
    workspace: workspace.name,
    slug: workspaceSlug,
    totalPatients: totalPatients ?? 0,
    totalAppointments: totalAppointments ?? 0,
    revenueThirtyDays: totalRevenue,
    currency,
    statusBreakdown: statusCounts,
  }
}

export async function getPatientSummary(workspaceSlug: string, patientEmail: string) {
  const db = getDB()
  const workspace = await resolveWorkspaceId(workspaceSlug)

  const { data: patient, error } = await db
    .from('patients')
    .select('id, full_name, email, phone, created_at')
    .eq('workspace_id', workspace.id)
    .ilike('email', patientEmail)
    .single()

  if (error || !patient) throw new Error(`Patient "${patientEmail}" not found.`)

  const { data: appointments } = await db
    .from('appointments')
    .select(`starts_at, ends_at, status, service:services(name), payment:payments(status, amount, currency), intake:intake_submissions(goal, activity_level, notes)`)
    .eq('workspace_id', workspace.id)
    .eq('patient_id', patient.id)
    .order('starts_at', { ascending: false })
    .limit(10)

  return {
    workspace: workspace.name,
    patient: {
      id: patient.id,
      name: patient.full_name,
      email: patient.email,
      phone: patient.phone,
      memberSince: patient.created_at,
    },
    appointments: (appointments ?? []).map(appt => {
      const service = appt.service as unknown as { name: string } | null
      const payment = appt.payment as unknown as { status: string; amount: number; currency: string }[] | null
      const intake = appt.intake as unknown as { goal?: string; activity_level?: string; notes?: string } | null
      return {
        date: format(new Date(appt.starts_at as string), "d MMM yyyy 'a las' HH:mm", { locale: es }),
        service: service?.name ?? 'Consulta',
        status: appt.status,
        payment: Array.isArray(payment) && payment.length > 0
          ? { status: payment[0]?.status, amount: payment[0]?.amount, currency: payment[0]?.currency }
          : null,
        intake: intake ?? null,
      }
    }),
  }
}
