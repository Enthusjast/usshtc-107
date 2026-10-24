const test = require('node:test');
const assert = require('node:assert/strict');
const {
  APP_DEFAULTS,
  PROFILE_DEFAULTS,
  APP_SETTING_KEYS,
  PROFILE_SETTING_KEYS,
  TMUX_STARTUP_COMMAND,
  parseHost,
  parseInteger,
  parseToken,
  validateSettingsPatch,
} = require('../../shared/settings-schema.mjs');
const { createDefaultRoot, publicSettings } = require('../../electron/settings-store');
const { buildManagedBlock } = require('../../electron/ssh-config-service');

const defaults = { ...APP_DEFAULTS, ...PROFILE_DEFAULTS };

function rejectsCode(action, code) {
  assert.throws(action, (error) => error instanceof TypeError && error.code === code && error.message === code);
}

test('public settings expose only the selected profile and application preferences', () => {
  const root = createDefaultRoot();
  root.app.locale = 'zh';
  root.profiles[0].settings.port = 4000;
  root.profiles[0].secrets = { ssoUsername: 'private-user', ssoPassword: 'private-password', savedCookieEncrypted: 'private-cookie' };
  const visible = publicSettings(root);
  assert.equal(visible.port, 4000);
  assert.equal(visible.locale, 'zh');
  assert.doesNotMatch(JSON.stringify(visible), /private-user|private-password|private-cookie|ssoUsername|ssoPassword|savedCookieEncrypted/);
  assert.equal('keys' in visible, false);
  assert.equal('keyTransaction' in visible, false);
});

test('host parsing accepts IPv4, full/compressed/mapped IPv6, localhost and DNS labels', () => {
  for (const value of [
    '0.0.0.0', '255.255.255.255', '127.0.0.1', 'localhost', 'LOCALHOST',
    'example.com', 'a-b.example', 'node1', '123', '::', '::1', '2001:db8::1',
    '2001:DB8:0:0:0:0:0:1', '1:2:3:4:5:6:7:8', '::ffff:192.0.2.1',
    '1:2:3:4:5:6:192.0.2.1', `${'a'.repeat(63)}.com`,
  ]) {
    assert.equal(parseHost(value, 'host'), value);
    assert.equal(parseHost(` ${value} `, 'host'), value);
  }
  const maximumDnsName = `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(61)}`;
  assert.equal(parseHost(maximumDnsName, 'host').length, 253);
});

test('host parsing rejects malformed addresses and SSH directives', () => {
  for (const value of [
    '256.1.1.1', '01.2.3.4', '1.2.3', '1.2.3.4.5', '.example', 'example.',
    'a..b', '-example.com', 'example-.com', 'a_b.com', 'https://example.com',
    '[::1]', '127.0.0.1:3000', 'fe80::1%eth0', ':', ':::1', '1:::2',
    '1::2::3', '1:2:3:4:5:6:7', '1:2:3:4:5:6:7:8:9',
    '1:2:3:4:5:6:7::8', '12345::1', '::ffff:999.0.0.1', '::192.00.2.1',
    '::gg', 'host name', 'host\u00a0name', '主机.example', `${'a'.repeat(64)}.com`,
    'a'.repeat(254),
  ]) rejectsCode(() => parseHost(value, 'host'), 'invalid_host');
  rejectsCode(() => parseHost('', 'host'), 'required');
  rejectsCode(() => parseHost('   ', 'host'), 'required');
  rejectsCode(() => parseHost(null, 'host'), 'required');
  rejectsCode(() => parseHost(123, 'host'), 'invalid_host');
});

test('raw controls cannot be hidden by trim in any string parser', () => {
  for (const control of ['\n', '\r', '\t', '\0', '\x1b', '\x7f', '\x85', '\u2028', '\u2029']) {
    for (const wrap of [(value) => `${control}${value}`, (value) => `${value}${control}`]) {
      rejectsCode(() => parseHost(wrap('localhost'), 'host'), 'invalid_host');
      rejectsCode(() => parseToken(wrap('training'), 'cluster'), 'invalid_token');
      rejectsCode(() => parseInteger(wrap('3000'), 'port', 1, 65535), 'integer_range');
    }
  }
});

test('integer fields enforce exact ranges and reject coercion traps', () => {
  for (const [field, min, max] of [['port', 1, 65535], ['cols', 40, 500], ['rows', 10, 200]]) {
    for (const value of [min, max, ` ${min} `, String(max)]) {
      const result = validateSettingsPatch({ [field]: value }, defaults);
      assert.equal(result.ok, true);
      assert.equal(result.value[field], Number(value));
    }
    for (const value of [min - 1, max + 1, 1.5, NaN, Infinity, -Infinity, true, false, [], {}, '0x50', '1e2', '40.0']) {
      assert.deepEqual(validateSettingsPatch({ [field]: value }, defaults), {
        ok: false, fieldErrors: { [field]: 'integer_range' },
      });
    }
    for (const value of ['', ' ', null, undefined]) {
      assert.deepEqual(validateSettingsPatch({ [field]: value }, defaults), {
        ok: false, fieldErrors: { [field]: 'required' },
      });
    }
  }
});

test('tokens enforce allowed characters and independent field lengths', () => {
  assert.equal(parseToken(' training-1_a.b ', 'cluster'), 'training-1_a.b');
  assert.equal(validateSettingsPatch({ cluster: 'a'.repeat(128), sshAlias: 'b'.repeat(64) }).ok, true);
  assert.deepEqual(validateSettingsPatch({ cluster: 'a'.repeat(129), sshAlias: 'b'.repeat(65) }), {
    ok: false, fieldErrors: { cluster: 'invalid_token', sshAlias: 'invalid_token' },
  });
  for (const value of ['a b', 'a/b', 'a"', 'a;id', '你好', 4, {}]) {
    rejectsCode(() => parseToken(value, 'cluster'), 'invalid_token');
  }
  rejectsCode(() => parseToken('', 'cluster'), 'required');
});

test('boolean and enum validation preserves existing supported representations', () => {
  for (const key of ['useRoot', 'autoConnect', 'healthProbeEnabled', ...APP_SETTING_KEYS.filter((key) => typeof APP_DEFAULTS[key] === 'boolean')]) {
    for (const value of [true, false, 'true', 'false']) {
      assert.equal(validateSettingsPatch({ [key]: value }).value[key], value === true || value === 'true');
    }
    for (const value of [0, 1, null, undefined, 'TRUE', '', ' false ', 'false\n']) {
      assert.deepEqual(validateSettingsPatch({ [key]: value }), { ok: false, fieldErrors: { [key]: 'invalid_boolean' } });
    }
  }
  for (const theme of ['dark', 'light']) assert.equal(validateSettingsPatch({ theme }).value.theme, theme);
  for (const locale of ['en', 'zh']) assert.equal(validateSettingsPatch({ locale }).value.locale, locale);
  assert.deepEqual(validateSettingsPatch({ theme: 'Dark', locale: 'en\n' }), {
    ok: false, fieldErrors: { theme: 'invalid_enum', locale: 'invalid_enum' },
  });
});

test('patches merge atomically without mutating current settings or disclosing rejected values', () => {
  const current = { ...defaults, savedCookieEncrypted: 'private-current-value' };
  const patch = { port: '4000', cluster: ' training-2 ' };
  assert.deepEqual(validateSettingsPatch(patch, current), {
    ok: true, value: { ...current, port: 4000, cluster: 'training-2' },
  });
  assert.equal(current.port, 3000);
  assert.equal(patch.port, '4000');
  const result = validateSettingsPatch({ host: 'SECRET\nINPUT', cols: 1, savedCookieEncrypted: 'PRIVATE' }, current);
  assert.deepEqual(result, {
    ok: false, fieldErrors: { host: 'invalid_host', cols: 'integer_range', savedCookieEncrypted: 'unknown_key' },
  });
  assert.equal(JSON.stringify(result).includes('SECRET'), false);
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
  assert.equal('value' in result, false);
  assert.deepEqual(validateSettingsPatch({}, current), { ok: true, value: current });
});

test('invalid patch shapes and prototype names cannot bypass the key whitelist', () => {
  for (const input of [null, undefined]) {
    assert.deepEqual(validateSettingsPatch(input), { ok: false, fieldErrors: { settings: 'required' } });
  }
  for (const input of [true, 42, 'host', [], new Date(), Object.create({ host: 'evil' })]) {
    assert.deepEqual(validateSettingsPatch(input), { ok: false, fieldErrors: { settings: 'unknown_key' } });
  }
  const input = JSON.parse('{"__proto__":"secret","constructor":"secret","toString":"secret"}');
  const result = validateSettingsPatch(input);
  assert.equal(result.ok, false);
  for (const key of Object.keys(input)) {
    assert.equal(Object.hasOwn(result.fieldErrors, key), true);
    assert.equal(result.fieldErrors[key], 'unknown_key');
  }
  assert.deepEqual(validateSettingsPatch(Object.assign(Object.create(null), { port: '4000' })), {
    ok: true, value: { ...defaults, port: 4000 },
  });
});


test('SSH config generation consumes the same host, port and alias validation', () => {
  const block = buildManagedBlock({ alias: ' alias ', host: ' ::1 ', port: '3000', privateKeyPath: '/fixture/key' });
  assert.match(block, /Host alias\n  HostName ::1\n  Port 3000/);
  rejectsCode(() => buildManagedBlock({ alias: 'alias\n', host: 'localhost', port: 3000, privateKeyPath: '/fixture/key' }), 'invalid_token');
  rejectsCode(() => buildManagedBlock({ alias: 'alias', host: 'localhost\n', port: 3000, privateKeyPath: '/fixture/key' }), 'invalid_host');
});

test('remote path is optional, length-bounded and preserves POSIX spaces and punctuation', () => {
  assert.equal(PROFILE_DEFAULTS.path, '');
  for (const path of ['', ' ', ' /home/research data/目录 & # +% ', 'a'.repeat(1024)]) {
    const result = validateSettingsPatch({ path });
    assert.equal(result.ok, true);
    assert.equal(result.value.path, path);
  }
  for (const path of ['a'.repeat(1025), null, 1, {}, ...['\n', '\r', '\t', '\0', '\x1b', '\x7f', '\x85', '\u2028', '\u2029'].map((control) => `/home/a${control}`)]) {
    assert.deepEqual(validateSettingsPatch({ path }), { ok: false, fieldErrors: { path: 'invalid_path' } });
  }
});

test('session preservation is a conservative opt-in and health probes default off per profile', () => {
  assert.equal(PROFILE_DEFAULTS.startupCommand, '');
  assert.equal(PROFILE_DEFAULTS.healthProbeEnabled, false);
  for (const key of ['path', 'startupCommand', 'healthProbeEnabled']) {
    assert.equal(PROFILE_SETTING_KEYS.includes(key), true);
    assert.equal(APP_SETTING_KEYS.includes(key), false);
  }
  for (const startupCommand of ['', TMUX_STARTUP_COMMAND]) {
    assert.equal(validateSettingsPatch({ startupCommand }).value.startupCommand, startupCommand);
  }
  for (const startupCommand of [null, false, 'tmux', ` ${TMUX_STARTUP_COMMAND}`, `${TMUX_STARTUP_COMMAND}\n`, `${TMUX_STARTUP_COMMAND}; id`, 'tmux new -A -s other']) {
    assert.deepEqual(validateSettingsPatch({ startupCommand }), { ok: false, fieldErrors: { startupCommand: 'invalid_startup_command' } });
  }
});
