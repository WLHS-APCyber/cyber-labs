/*
 * cyber-labs submission proxy
 *
 * Sits between the static lab pages (GitHub Pages) and the Apps Script
 * backend. The browser only ever knows this Worker's public URL — the real
 * Apps Script /exec URL and the shared submission token live only as
 * Cloudflare secrets (env.APPS_SCRIPT_URL / env.SUBMISSION_TOKEN) and are
 * attached server-side, never sent to the client.
 */

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin');
    const corsHeaders = buildCorsHeaders(origin, env.ALLOWED_ORIGIN);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (request.method !== 'POST') {
      return jsonResponse({ success: false, error: 'Method not allowed' }, 405, corsHeaders);
    }

    let payload;
    try {
      payload = await request.json();
    } catch (err) {
      return jsonResponse({ success: false, error: 'Invalid JSON body' }, 400, corsHeaders);
    }

    if (!payload || typeof payload !== 'object' || !payload.assignmentId) {
      return jsonResponse({ success: false, error: 'Missing assignmentId' }, 400, corsHeaders);
    }

    // Overwrite whatever the client sent (or didn't) with the real secret.
    payload.submissionToken = env.SUBMISSION_TOKEN;

    let upstream;
    try {
      upstream = await fetch(env.APPS_SCRIPT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      return jsonResponse({ success: false, error: 'Upstream request failed: ' + (err && err.message) }, 502, corsHeaders);
    }

    const text = await upstream.text();
    return new Response(text, {
      status: upstream.status,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  },
};

function buildCorsHeaders(origin, allowedOrigin) {
  const allow = !allowedOrigin || allowedOrigin === '*'
    ? '*'
    : (origin === allowedOrigin ? origin : 'null');
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function jsonResponse(obj, status, corsHeaders) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });
}
