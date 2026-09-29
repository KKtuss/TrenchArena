function connectSources(nodeEnv) {
  const sources = new Set(["'self'"]);
  const wsUrl = process.env.NEXT_PUBLIC_WS_URL;
  if (wsUrl) {
    try {
      const url = new URL(wsUrl);
      if (url.protocol === 'ws:' || url.protocol === 'wss:' || url.protocol === 'http:' || url.protocol === 'https:') {
        sources.add(`${url.protocol}//${url.host}`);
      }
    } catch {
      // Invalid NEXT_PUBLIC_WS_URL is ignored rather than opening connect-src.
    }
  } else if (nodeEnv !== 'production') {
    sources.add('ws://127.0.0.1:3000');
    sources.add('http://127.0.0.1:3000');
  }
  return [...sources].join(' ');
}

/**
 * Next.js App Router emits inline bootstrap scripts, and React/Showdown use
 * inline styles. Those require 'unsafe-inline'. Showdown and the app do not
 * use eval()/new Function(), so 'unsafe-eval' stays omitted.
 */
function contentSecurityPolicy(nodeEnv = process.env.NODE_ENV) {
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "frame-src 'none'",
    "form-action 'self'",
    "script-src 'self' 'unsafe-inline'" + (nodeEnv !== 'production' ? " 'unsafe-eval'" : ""),
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https://play.pokemonshowdown.com",
    "font-src 'self' data:",
    "media-src 'self'",
    "worker-src 'self'",
    `connect-src ${connectSources(nodeEnv)}`,
  ].join('; ');
}

function securityHeaders() {
  return [
    { key: 'Content-Security-Policy', value: contentSecurityPolicy() },
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
    { key: 'X-Frame-Options', value: 'DENY' },
    { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
    { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
    { key: 'X-DNS-Prefetch-Control', value: 'off' },
  ];
}

module.exports = {
  contentSecurityPolicy,
  securityHeaders,
};
