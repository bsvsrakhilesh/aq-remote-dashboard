export const corsHeaders = (request: Request) => {
  const allowed = (Deno.env.get('ALLOWED_ORIGINS') ?? 'http://localhost:5173').split(',').map((v) => v.trim())
  const origin = request.headers.get('origin') ?? ''
  return { 'Access-Control-Allow-Origin': allowed.includes(origin) ? origin : allowed[0], 'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-device-id, x-device-key', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', Vary: 'Origin' }
}
export const json = (request: Request, body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...corsHeaders(request), 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } })
