const JSON_SECRET_PATTERN = /("(?:authorization|client_secret|code|cookie|id_token|password|passwd|refresh_token|savedCookieEncrypted|secret|set-cookie|ssoPassword|ticket|token|access_token)"\s*:\s*)"(?:\\.|[^"\\])*"/gi;
const ASSIGNMENT_SECRET_PATTERN = /\b(authorization|client_secret|code|cookie|id_token|password|passwd|refresh_token|savedCookieEncrypted|secret|set-cookie|ssoPassword|ticket|token|access_token)\s*[=:]\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}\]]+)/gi;
const MAX_LOG_MESSAGE_CHARS = 8192;
const TRUNCATION_SUFFIX = '... [truncated]';

function redactLogMessage(message) {
  const redacted = String(message ?? '')
    .replace(JSON_SECRET_PATTERN, '$1"[REDACTED]"')
    .replace(/\b(Cookie|Set-Cookie|Authorization)\s*:\s*[^\r\n]*/gi, '$1: [REDACTED]')
    .replace(/([?&][A-Za-z0-9_.~-]+=)[^\s&#"'<>]*/g, '$1[REDACTED]')
    .replace(ASSIGNMENT_SECRET_PATTERN, '$1=[REDACTED]')
    .replace(/\bExec(?: command)?\s*:\s*[^\r\n]*/gi, 'Exec: [REDACTED]');
  if (redacted.length <= MAX_LOG_MESSAGE_CHARS) return redacted;
  return `${redacted.slice(0, MAX_LOG_MESSAGE_CHARS - TRUNCATION_SUFFIX.length)}${TRUNCATION_SUFFIX}`;
}

module.exports = {
  MAX_LOG_MESSAGE_CHARS,
  redactLogMessage,
};
