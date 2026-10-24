'use strict';

const { isIP } = require('node:net');
const { PortalApiError } = require('../portal-api/client');

const invalid = () => new PortalApiError('UNKNOWN');
function text(value, maximum = 256, optional = false) {
  if (optional && value == null) return '';
  if (typeof value !== 'string' || value.length > maximum || /[\u0000-\u001f\u007f-\u009f]/.test(value)) throw invalid();
  return value;
}
function segment(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value)) throw invalid();
  return value;
}
function host(value) {
  text(value, 253);
  const ip = isIP(value);
  if (!ip && (!/^[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(value)
      || /^(?:0x[0-9a-f]+|\d+)(?:\.(?:0x[0-9a-f]+|\d+))*$/i.test(value)
      || value.split('.').some(label => !label || label.length > 63 || label.startsWith('-') || label.endsWith('-')))) throw invalid();
  const lower = value.toLowerCase();
  if (lower === 'localhost' || lower.endsWith('.localhost') || lower === '::' || lower === '::1'
      || /^fe[89ab][0-9a-f]:/i.test(value) || lower.startsWith('ff') && ip === 6
      || /^::ffff:/i.test(value) || /^(?:0|127|169\.254|22[4-9]|23\d|24\d|25[0-5])(?:\.|$)/.test(value)) throw invalid();
  return value;
}
function integer(value, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw invalid();
  return value;
}
function port(value) { return integer(value, 1, 65535); }
function array(value, maximum = 2000) {
  if (!Array.isArray(value) || value.length > maximum) throw invalid();
  return value;
}
function record(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  return value;
}
function connection(value) {
  record(value);
  return { host: host(value.host), port: port(value.port), password: text(value.password, 4096) };
}

module.exports = { text, segment, host, integer, port, array, record, connection, invalid };
