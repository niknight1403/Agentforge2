/** Optional link to a separately hosted OpenHands Agent Canvas instance. */
export function openHandsCanvasStatus(env = process.env) {
  const configured = String(env.OPENHANDS_CANVAS_URL || '').trim();
  if (!configured) return { enabled: false, url: null, state: 'not_configured' };
  if (configured.length > 2048) return { enabled: false, url: null, state: 'invalid_configuration' };

  try {
    const url = new URL(configured);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      return { enabled: false, url: null, state: 'invalid_configuration' };
    }
    url.hash = '';
    return { enabled: true, url: url.toString(), state: 'configured' };
  } catch {
    return { enabled: false, url: null, state: 'invalid_configuration' };
  }
}
