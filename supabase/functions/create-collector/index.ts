import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const allowedOrigin = Deno.env.get('APP_ORIGIN') ?? '*'
const corsHeaders = {
  'Access-Control-Allow-Origin': allowedOrigin,
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Vary': 'Origin',
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  const authorization = request.headers.get('Authorization')
  const token = authorization?.match(/^Bearer\s+(.+)$/i)?.[1]
  const projectUrl = Deno.env.get('SUPABASE_URL')
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!token || !projectUrl || !anonKey || !serviceKey) return json({ error: 'Invitation service is not configured' }, 500)

  try {
    const callerClient = createClient(projectUrl, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${token}` } },
    })
    const { data: userResult, error: userError } = await callerClient.auth.getUser(token)
    if (userError || !userResult.user) return json({ error: 'A valid signed-in account is required' }, 401)

    const adminClient = createClient(projectUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })
    const { data: profile, error: profileError } = await adminClient
      .from('profiles')
      .select('role,active')
      .eq('id', userResult.user.id)
      .single()
    if (profileError || profile?.role !== 'admin' || profile.active !== true) return json({ error: 'Administrator access required' }, 403)

    const body = await request.json()
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''
    const displayName = typeof body.displayName === 'string' ? body.displayName.trim() : ''
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: 'Enter a valid email address' }, 400)
    if (displayName.length < 1 || displayName.length > 120) return json({ error: 'Display name must be between 1 and 120 characters' }, 400)

    const { data: invitation, error: inviteError } = await adminClient.auth.admin.inviteUserByEmail(email, {
      data: { display_name: displayName },
    })
    if (inviteError) return json({ error: inviteError.message }, 400)
    return json({ invited: true, userId: invitation.user.id }, 200)
  } catch {
    return json({ error: 'Invitation could not be completed' }, 500)
  }
})

function json(body: Record<string, unknown>, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}