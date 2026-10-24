import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, copyToClipboard, getSettings, getSsoCredentials, saveSettings, setAppDirty, getProfiles, createProfile, renameProfile, deleteProfile, activateProfile, saveAppSettings, retryLoadSettings, previewSshConfig, generateSshConfig } from '../src/lib/electron';
import { formatApiError, formatValidationError } from '../src/lib/api-errors';
import { getHistory, clearHistory, startDiagnostics, cancelDiagnostics, getDiagnostics, onDiagnosticsState, exportLogs, exportDiagnostics } from '../src/lib/electron';
import { getAutostart, setAutostart, retryRecovery } from '../src/lib/electron';
import { getSshKeyInfo, exportKeyBackup, importKeyBackup, rotateSshKeys, rebuildSshKeys } from '../src/lib/electron';
import en from '../src/i18n/en';
import zh from '../src/i18n/zh';

afterEach(() => { delete globalThis.electronAPI; });

function bridge(method, result) {
  const callback = vi.fn().mockResolvedValue(result);
  globalThis.electronAPI = { isElectron: true, [method]: callback };
  return callback;
}

describe('strict Electron invoke contract', () => {
  it('rejects unavailable runtime instead of silently succeeding', async () => {
    await expect(setAppDirty(true)).rejects.toMatchObject({ code: 'RUNTIME_UNAVAILABLE' });
    await expect(copyToClipboard('text')).rejects.toMatchObject({ code: 'RUNTIME_UNAVAILABLE' });
  });

  it('rejects a missing API', async () => {
    globalThis.electronAPI = { isElectron: true };
    await expect(getSettings()).rejects.toMatchObject({ code: 'API_UNAVAILABLE' });
  });

  it('unwraps getters, actions and null successful values', async () => {
    bridge('getSettings', { ok: true, value: { port: 3000 } });
    await expect(getSettings({profileId:'default',epoch:1})).resolves.toEqual({ port: 3000 });
    const callback = bridge('setAppDirty', { ok: true, value: null });
    const draft = { scope: { profileId: 'default', epoch: 1 }, dirty: true, draftRevision: 2 };
    await expect(setAppDirty(draft)).resolves.toBeNull();
    expect(callback).toHaveBeenCalledWith(draft);
    bridge('copyToClipboard', { ok: true, value: null });
    await expect(copyToClipboard('text')).resolves.toBeNull();
  });

  it('returns cancellation as a successful value', async () => {
    bridge('saveSettings', { ok: true, value: { cancelled: true } });
    await expect(saveSettings({scope:{profileId:'default',epoch:1},patch:{host:'localhost'}})).resolves.toEqual({ cancelled: true });
  });

  it('throws fixed ApiError codes and validation fields without backend messages', async () => {
    bridge('saveSettings', { ok: false, error: { code: 'VALIDATION_FAILED', fieldErrors: { host: 'invalid_host' } } });
    await expect(saveSettings({scope:{profileId:'default',epoch:1},patch:{host:'\n'}})).rejects.toEqual(new ApiError('VALIDATION_FAILED', { host: 'invalid_host' }));
  });

  it.each([undefined, null, true, {}, { ok: true }, { success: true }, { ok: false, error: 'secret' }, { ok: true, value: null, error: {} }, { ok: false, error: { code: 'INVALID_ARGUMENT', fieldErrors: [] } }])('rejects malformed envelopes: %j', async (value) => {
    bridge('getSettings', value);
    await expect(getSettings()).rejects.toMatchObject({ code: 'API_UNAVAILABLE' });
  });

  it('sanitizes rejected transport errors including clipboard failures', async () => {
    const callback = bridge('copyToClipboard', null);
    callback.mockRejectedValue(new Error('private backend message'));
    await expect(copyToClipboard('text')).rejects.toMatchObject({ code: 'INTERNAL_ERROR', message: 'INTERNAL_ERROR' });
  });

  it('consumes the credential status DTO without deriving password compatibility', async () => {
    const callback = bridge('getSsoCredentials', { ok: true, value: { profileId:'default', username: 'SA123', hasPassword: false, storageAvailable: true } });
    await expect(getSsoCredentials({profileId:'default',epoch:1})).resolves.toEqual({ profileId:'default', username: 'SA123', hasPassword: false, storageAvailable: true });
    expect(callback).toHaveBeenCalledWith({profileId:'default',epoch:1});
  });

  it.each([
    ['getProfiles', getProfiles, undefined],
    ['createProfile', createProfile, {scope:{profileId:'default',epoch:2},name:'Work',settings:{port:4000}}],
    ['renameProfile', renameProfile, {scope:{profileId:'default',epoch:2},id:'b',name:'Research'}],
    ['deleteProfile', deleteProfile, {scope:{profileId:'default',epoch:2},id:'b'}],
    ['activateProfile', activateProfile, {scope:{profileId:'default',epoch:2},id:'b'}],
    ['saveAppSettings', saveAppSettings, {startMinimized:true}],
    ['retryLoadSettings', retryLoadSettings, {profileId:'default',epoch:2}],
    ['previewSshConfig', previewSshConfig, {profileId:'default',epoch:2}],
    ['generateSshConfig', generateSshConfig, {scope:{profileId:'default',epoch:2},sourceHash:'a'.repeat(64),configHash:'b'.repeat(64)}],
    ['getHistory', getHistory, {scope:{profileId:'default',epoch:2},days:7}],
    ['clearHistory', clearHistory, {profileId:'default',epoch:2}],
    ['startDiagnostics', startDiagnostics, {profileId:'default',epoch:2}],
    ['cancelDiagnostics', cancelDiagnostics, {scope:{profileId:'default',epoch:2},runId:'run-1'}],
    ['getDiagnostics', getDiagnostics, {profileId:'default',epoch:2}],
    ['exportLogs', exportLogs, {scope:{profileId:'default',epoch:2},filters:{query:'retry',level:'warn',source:'all',from:null,to:null}}],
    ['exportDiagnostics', exportDiagnostics, {profileId:'default',epoch:2}],
    ['getAutostart', getAutostart, undefined],
    ['setAutostart', setAutostart, false],
    ['retryRecovery', retryRecovery, {profileId:'default',epoch:2}],
    ['getSshKeyInfo', getSshKeyInfo, {profileId:'default',epoch:2}],
    ['exportKeyBackup', exportKeyBackup, {profileId:'default',epoch:2}],
    ['importKeyBackup', importKeyBackup, {profileId:'default',epoch:2}],
    ['rotateSshKeys', rotateSshKeys, {scope:{profileId:'default',epoch:2},target:'host'}],
    ['rebuildSshKeys', rebuildSshKeys, {scope:{profileId:'default',epoch:2},target:'both'}],
  ])('forwards only the fixed %s method and its final payload', async (name, invoke, payload) => {
    const callback = bridge(name, {ok:true,value:{cancelled:true}});
    await expect(payload === undefined ? invoke() : invoke(payload)).resolves.toEqual({cancelled:true});
    if (payload === undefined) expect(callback).toHaveBeenCalledWith();
    else expect(callback).toHaveBeenCalledExactlyOnceWith(payload);
  });

  it('does not derive credentials from public profiles or require passwords in their DTO', async () => {
    const value = {activeProfileId:'default',profiles:[{id:'default',name:'Default',settings:{port:3000},onboarding:{status:'dismissed',step:'login'}}]};
    const callback = bridge('getProfiles', {ok:true,value});
    await expect(getProfiles()).resolves.toEqual(value);
    expect(callback).toHaveBeenCalledWith();
    expect(value.profiles[0]).not.toHaveProperty('secrets');
    expect(value.profiles[0]).not.toHaveProperty('username');
  });
});

it('returns only the main-provided SSH preview DTO and preserves optimistic conflict errors',async()=>{
  const scope={profileId:'default',epoch:2};
  const value={block:'Host usshtc107\nHost *\n',changed:true,sourceHash:'a'.repeat(64),configHash:'b'.repeat(64),backupPath:null};
  const callback=bridge('previewSshConfig',{ok:true,value});
  await expect(previewSshConfig(scope)).resolves.toEqual(value);
  expect(callback).toHaveBeenCalledExactlyOnceWith(scope);
  bridge('generateSshConfig',{ok:false,error:{code:'SSH_CONFIG_CHANGED'}});
  await expect(generateSshConfig({scope,sourceHash:value.sourceHash,configHash:value.configHash})).rejects.toEqual(new ApiError('SSH_CONFIG_CHANGED'));
});

it('subscribes only to diagnostic state and releases its event listener', () => {
  const unsubscribe = vi.fn();
  const callback = vi.fn();
  const subscribe = vi.fn().mockReturnValue(unsubscribe);
  globalThis.electronAPI = { isElectron: true, onDiagnosticsState: subscribe };
  expect(onDiagnosticsState(callback)).toBe(unsubscribe);
  expect(subscribe).toHaveBeenCalledExactlyOnceWith(callback);
});

it('unwraps an empty diagnostic result without manufacturing a successful run', async () => {
  bridge('getDiagnostics', {ok:true,value:null});
  await expect(getDiagnostics({profileId:'default',epoch:2})).resolves.toBeNull();
});

describe('safe translated API errors', () => {
  for (const [locale, dictionary] of Object.entries({ en, zh })) {
    const t = (key) => dictionary[key];
    it(`translates fixed errors and validation codes in ${locale}`, () => {
      expect(formatApiError(new ApiError('AUTH_REQUIRED'), t)).toBe(dictionary.error_AUTH_REQUIRED);
      expect(formatValidationError('invalid_host', t)).toBe(dictionary.validation_invalid_host);
      expect(formatApiError({ code: 'arbitrary', message: 'secret' }, t)).toBe(dictionary.unknownError);
      expect(formatApiError(new Error('secret'), t)).toBe(dictionary.unknownError);
      expect(formatValidationError('secret', t)).toBe(dictionary.unknownError);
      for (const code of ['EXPORT_FAILED', 'SSH_CONFIG_INVALID', 'SSH_CONFIG_CHANGED', 'SSH_ALIAS_CONFLICT', 'HISTORY_STORAGE_FAILED', 'HISTORY_WRITE_FAILED', 'HISTORY_INVALID', 'HISTORY_LOAD_FAILED']) {
        expect(formatApiError({code,message:'private config text'},t)).toBeTypeOf('string');
        expect(formatApiError({code,message:'private config text'},t)).toBe(dictionary[`error_${code}`]);
        expect(formatApiError({code,message:'private config text'},t)).not.toContain('private config text');
      }
      for (const code of ['AUTOSTART_UNAVAILABLE','AUTOSTART_CONFLICT','AUTOSTART_FAILED','NETWORK_UNAVAILABLE','WSS_FAILED','TLS_FAILED','TIMEOUT','PORT_IN_USE']) {
        expect(formatApiError({code,message:'private OS path'},t)).toBe(dictionary[`error_${code}`]);
        expect(dictionary[`error_${code}`]).toBeTypeOf('string');
      }
      expect(formatApiError({code:'RECOVERY_EXHAUSTED'},t)).toBe(dictionary.error_RECOVERY_EXHAUSTED);
      expect(dictionary.error_RECOVERY_EXHAUSTED).toBeTypeOf('string');
      for (const code of ['SSH_KEY_MISSING','SSH_KEY_INVALID','SSH_KEY_FINGERPRINT_MISMATCH','KEY_BACKUP_INVALID','KEY_TRANSACTION_FAILED','KEY_ROLLBACK_FAILED','SECURE_STORAGE_UNAVAILABLE']) {
        expect(formatApiError({code,message:'private key contents'},t)).toBe(dictionary[`error_${code}`]);
        expect(dictionary[`error_${code}`]).toBeTypeOf('string');
        expect(dictionary[`error_${code}`]).not.toContain('private key contents');
      }
      for (const code of ['SETTINGS_LOCKED','SETTINGS_COMMIT_UNKNOWN','SETTINGS_DURABILITY_UNCERTAIN','SETTINGS_RECOVERY_REQUIRED','SETTINGS_INVALID','SETTINGS_VERSION_UNSUPPORTED','SETTINGS_FILE_TOO_LARGE','SETTINGS_LOAD_FAILED','SETTINGS_SAVE_FAILED','SETTINGS_MIGRATION_FAILED','PROFILE_NAME_INVALID','PROFILE_ALIAS_CONFLICT','PROFILE_LIMIT','PROFILE_LAST','PROFILE_NOT_FOUND']) {
        expect(formatApiError(new ApiError(code), t)).toBeTypeOf('string');
        expect(formatApiError(new ApiError(code), t)).toBe(dictionary[`error_${code}`]);
      }
    });
  }
});

it('passes the application key DTO through without synthesizing flat legacy aliases',async()=>{
 const scope={profileId:'default',epoch:3};
 const value={scope:'application',client:{state:'ready',publicKey:'ssh-ed25519 public',fingerprint:'SHA256:client',privateKeyPath:'/tmp/client'},host:{state:'changed',fingerprint:'SHA256:host',privateKeyPath:'/tmp/host'},recoveryRequired:true};
 const callback=bridge('getSshKeyInfo',{ok:true,value}); const result=await getSshKeyInfo(scope);
 expect(callback).toHaveBeenCalledExactlyOnceWith(scope); expect(result).toEqual(value);
 expect(result).not.toHaveProperty('publicKey'); expect(result).not.toHaveProperty('privateKeyPath'); expect(result).not.toHaveProperty('privateKey');
});
