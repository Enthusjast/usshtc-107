import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { beforeEach, it, expect, vi } from 'vitest';
import SettingsView from '../src/views/SettingsView';
import { LocaleProvider } from '../src/i18n/LocaleContext';
import { ToastProvider } from '../src/components/Toast';
import en from '../src/i18n/en';
import zh from '../src/i18n/zh';
import { formatApiError, formatValidationError } from '../src/lib/api-errors';
const mocks = vi.hoisted(() => ({ retryLoadSettings:vi.fn(),exportKeyBackup:vi.fn(),importKeyBackup:vi.fn(),rotateSshKeys:vi.fn(),rebuildSshKeys:vi.fn(),getAutostart:vi.fn(),setAutostart:vi.fn(),getSettings:vi.fn(),saveSettings:vi.fn(),saveAppSettings:vi.fn(),getRuntimeInfo:vi.fn(),previewSshConfig:vi.fn(),generateSshConfig:vi.fn(),saveSsoCredentials:vi.fn(),getSsoCredentials:vi.fn(),clearSsoCredentials:vi.fn(),getSshKeyInfo:vi.fn(),copyToClipboard:vi.fn(),setAppLocale:vi.fn(),restartProxy:vi.fn(),getStatus:vi.fn(),onRuntimeState:vi.fn() }));
const runtime = vi.hoisted(() => ({scope:{profileId:'default',epoch:1},snapshot:{needsRestart:false},flushDraft:vi.fn(),retry:vi.fn(),getScope:vi.fn(),getSnapshot:vi.fn()}));
vi.mock('../src/lib/electron',async (importOriginal)=>({...await importOriginal(),...mocks}));
vi.mock('../src/contexts/RuntimeContext',()=>({useRuntime:()=>runtime,sameScope:(a,b)=>Boolean(a&&b&&a.profileId===b.profileId&&a.epoch===b.epoch)}));
vi.mock('../src/components/UpdatePanel', () => ({ default: () => <section aria-label="Updates panel isolated in settings unit tests" /> }));
const settings={host:'127.0.0.1',port:3000,cluster:'training',loginNode:'11.11.10.202',cols:80,rows:24,useRoot:false,autoConnect:true,startMinimized:false,theme:'dark',locale:'en',sshAlias:'usshtc107'};
const preview = {block:'# BEGIN managed\nHost usshtc107\n  Port 3000\nHost *\n# END managed\n',changed:true,sourceHash:'a'.repeat(64),configHash:'b'.repeat(64),backupPath:'/tmp/config.backup'};
function mount(onDraftChange=vi.fn()) { return render(<LocaleProvider><ToastProvider><SettingsView onDraftChange={onDraftChange}/></ToastProvider></LocaleProvider>); }
beforeEach(()=>{
 vi.resetAllMocks(); runtime.scope={profileId:'default',epoch:1}; runtime.snapshot={needsRestart:false}; runtime.flushDraft.mockResolvedValue();
 runtime.getScope.mockImplementation(()=>runtime.scope);
 runtime.getSnapshot.mockImplementation(()=>({...runtime.scope,operation:null,errorCode:null,...runtime.snapshot}));
 mocks.getStatus.mockResolvedValue({...runtime.scope,revision:1}); mocks.onRuntimeState.mockReturnValue(vi.fn());
 mocks.getSettings.mockResolvedValue(settings); mocks.getRuntimeInfo.mockResolvedValue({platform:'linux'});
 mocks.getAutostart.mockResolvedValue({supported:true,enabled:false,approvalRequired:false,errorCode:null});
 mocks.setAutostart.mockImplementation(async(enabled)=>({supported:true,enabled,approvalRequired:false,errorCode:null}));
 mocks.getSshKeyInfo.mockResolvedValue({scope:'application',client:{state:'ready',publicKey:'ssh-ed25519 test',fingerprint:'SHA256:client',privateKeyPath:'/tmp/key'},host:{state:'ready',fingerprint:'SHA256:host',privateKeyPath:'/tmp/host'},recoveryRequired:false});
 mocks.getSsoCredentials.mockResolvedValue({profileId:'default',username:'SA123',hasPassword:true,storageAvailable:true});
 mocks.saveSettings.mockResolvedValue({}); mocks.saveAppSettings.mockResolvedValue({}); mocks.saveSsoCredentials.mockResolvedValue({});
 mocks.previewSshConfig.mockResolvedValue(preview);
 mocks.generateSshConfig.mockResolvedValue({...preview,changed:false,path:'/tmp/config'});
});

it('keeps path empty and tmux and health probes off for older settings until explicitly saved', async () => {
 const draft = vi.fn(); mount(draft);
 const path = await screen.findByLabelText('Starting directory');
 expect(path).toHaveValue(''); expect(path).toHaveAttribute('maxlength', '1024');
 expect(screen.getByLabelText('Keep interactive sessions with tmux')).not.toBeChecked();
 expect(screen.getByLabelText('Enable read-only health probes')).not.toBeChecked();
 expect(screen.getByLabelText('Enable read-only health probes')).toHaveAccessibleDescription(/Each periodic read-only command opens a remote session.*shellLogin/);
 expect(screen.getByLabelText('Use Root')).toHaveAccessibleDescription(/additional authorization.*ordinary account will fail/);
 expect(mocks.saveSettings).not.toHaveBeenCalled();
 fireEvent.change(path, { target: { value: ' /home/research data/目录 &% ' } });
 fireEvent.click(screen.getByLabelText('Keep interactive sessions with tmux'));
 fireEvent.click(screen.getByLabelText('Enable read-only health probes'));
 expect(draft).toHaveBeenLastCalledWith({ dirty: true, draftRevision: 3 });
 fireEvent.click(screen.getByRole('button', { name: 'Save Settings' }));
 await waitFor(() => expect(mocks.saveSettings).toHaveBeenCalledExactlyOnceWith({ scope: runtime.scope, patch: { path: ' /home/research data/目录 &% ', startupCommand: 'tmux new -A -s usshtc', healthProbeEnabled: true } }));
 await waitFor(() => expect(draft).toHaveBeenLastCalledWith({ dirty: false, draftRevision: 3 }));
 expect(mocks.saveAppSettings).not.toHaveBeenCalled();
 expect(mocks.restartProxy).not.toHaveBeenCalled();
});

it('retains saved path and opt-ins and resets them to unsaved conservative defaults', async () => {
 mocks.getSettings.mockResolvedValue({ ...settings, path: '/work dir', startupCommand: 'tmux new -A -s usshtc', healthProbeEnabled: true });
 const draft = vi.fn(); mount(draft);
 expect(await screen.findByLabelText('Starting directory')).toHaveValue('/work dir');
 expect(screen.getByLabelText('Keep interactive sessions with tmux')).toBeChecked();
 expect(screen.getByLabelText('Enable read-only health probes')).toBeChecked();
 fireEvent.click(screen.getByRole('button', { name: 'Reset to defaults' }));
 expect(screen.getByLabelText('Starting directory')).toHaveValue('');
 expect(screen.getByLabelText('Keep interactive sessions with tmux')).not.toBeChecked();
 expect(screen.getByLabelText('Enable read-only health probes')).not.toBeChecked();
 expect(draft).toHaveBeenLastCalledWith({ dirty: true, draftRevision: 1 });
 expect(mocks.saveSettings).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole('button', { name: 'Save Settings' }));
 await waitFor(() => expect(mocks.saveSettings).toHaveBeenCalled());
 expect(mocks.saveSettings.mock.calls[0][0].patch).toMatchObject({ path: '', startupCommand: '', healthProbeEnabled: false });
});

it.each(['0.0.0.0', '::', '192.0.2.1', '127.0.0.2', 'example.com'])('warns meaningfully before saving a non-loopback binding %s', async (host) => {
 mount(); const input = await screen.findByLabelText('Host');
 fireEvent.change(input, { target: { value: host } });
 expect(input).toHaveAccessibleDescription(/Other machines may reach the local SSH proxy.*firewall/);
 expect(screen.getByText(/Warning: this address is not loopback/)).toHaveAttribute('role', 'status');
 expect(mocks.saveSettings).not.toHaveBeenCalled();
});

it.each(['127.0.0.1', '::1', 'localhost', 'LOCALHOST', ' localhost '])('does not warn for the supported loopback binding %s', async (host) => {
 mocks.getSettings.mockResolvedValue({ ...settings, host }); mount();
 await screen.findByLabelText('Host');
 expect(screen.queryByText(/Warning: this address is not loopback/)).not.toBeInTheDocument();
});

it('shows path validation at its field and never saves an overlong draft', async () => {
 const draft = vi.fn(); mount(draft); const path = await screen.findByLabelText('Starting directory');
 fireEvent.change(path, { target: { value: 'a'.repeat(1025) } });
 fireEvent.click(screen.getByRole('button', { name: 'Save Settings' }));
 expect(await screen.findByText(en.validation_invalid_path)).toBeInTheDocument();
 expect(path).toHaveAttribute('aria-invalid', 'true');
 expect(path).toHaveAccessibleDescription(new RegExp('Use at most 1,024 characters'));
 expect(mocks.saveSettings).not.toHaveBeenCalled();
 expect(draft).toHaveBeenLastCalledWith({ dirty: true, draftRevision: 1 });
});

it('saves the health-only profile preference without invalidating an existing SSH config preview', async () => {
 mount(); await screen.findByLabelText('Host');
 fireEvent.click(screen.getByRole('button', { name: 'Preview saved SSH config' }));
 await screen.findByLabelText('Managed SSH config block preview');
 fireEvent.click(screen.getByLabelText('Enable read-only health probes'));
 expect(screen.getByLabelText('Managed SSH config block preview')).toBeInTheDocument();
 fireEvent.click(screen.getByRole('button', { name: 'Save Settings' }));
 await waitFor(() => expect(mocks.saveSettings).toHaveBeenCalledExactlyOnceWith({ scope: runtime.scope, patch: { healthProbeEnabled: true } }));
 expect(mocks.restartProxy).not.toHaveBeenCalled();
 expect(mocks.saveAppSettings).not.toHaveBeenCalled();
});

it('disables the tmux opt-in with an explicit empty command and invalidates the connection preview', async () => {
 mocks.getSettings.mockResolvedValue({ ...settings, startupCommand: 'tmux new -A -s usshtc' });
 const draft = vi.fn(); mount(draft); await screen.findByLabelText('Host');
 fireEvent.click(screen.getByRole('button', { name: 'Preview saved SSH config' }));
 await screen.findByLabelText('Managed SSH config block preview');
 fireEvent.click(screen.getByLabelText('Keep interactive sessions with tmux'));
 expect(screen.queryByLabelText('Managed SSH config block preview')).not.toBeInTheDocument();
 expect(draft).toHaveBeenLastCalledWith({ dirty: true, draftRevision: 1 });
 fireEvent.click(screen.getByRole('button', { name: 'Save Settings' }));
 await waitFor(() => expect(mocks.saveSettings).toHaveBeenCalledExactlyOnceWith({ scope: runtime.scope, patch: { startupCommand: '' } }));
});

it('loads each profile’s remote preferences without carrying over another profile’s opt-ins', async () => {
 mocks.getSettings.mockResolvedValue({ ...settings, path: '/profile-a', startupCommand: 'tmux new -A -s usshtc', healthProbeEnabled: true });
 const view = mount(); expect(await screen.findByLabelText('Starting directory')).toHaveValue('/profile-a');
 runtime.scope = { profileId: 'b', epoch: 2 };
 mocks.getSettings.mockResolvedValue({ ...settings, path: '/profile b', startupCommand: '', healthProbeEnabled: false });
 mocks.getSsoCredentials.mockResolvedValue({ profileId: 'b', username: '', hasPassword: false, storageAvailable: true });
 view.rerender(<LocaleProvider><ToastProvider><SettingsView key="b" /></ToastProvider></LocaleProvider>);
 expect(await screen.findByLabelText('Starting directory')).toHaveValue('/profile b');
 expect(screen.getByLabelText('Keep interactive sessions with tmux')).not.toBeChecked();
 expect(screen.getByLabelText('Enable read-only health probes')).not.toBeChecked();
 expect(mocks.saveSettings).not.toHaveBeenCalled();
});

it.each([en, zh])('localizes readiness and conservative validation without rendering backend messages', (messages) => {
 const t = (key) => messages[key];
 expect(formatApiError({ code: 'REMOTE_READY_TIMEOUT', message: 'private backend message' }, t)).toBe(messages.error_REMOTE_READY_TIMEOUT);
 expect(formatValidationError('invalid_path', t)).toBe(messages.validation_invalid_path);
 expect(formatValidationError('invalid_startup_command', t)).toBe(messages.validation_invalid_startup_command);
 for (const key of ['diagnostic_WSS_SHELL_READY', 'diagnostic_REMOTE_COMMAND_OK', 'diagnostic_REMOTE_READY_TIMEOUT', 'diagnosticsCheck_remote-command', 'keepTmuxSessionHint', 'healthProbeEnabledHint', 'nonLoopbackBindingWarning', 'useRootHint']) expect(messages[key]).toBeTruthy();
});
it('retains a saved false auto-check preference and saves only an explicit toggle as an app patch', async () => {
 mocks.getSettings.mockResolvedValue({ ...settings, autoCheckUpdates: false });
 const draft = vi.fn(); mount(draft);
 const preference = await screen.findByLabelText('Automatically check for updates');
 expect(preference).not.toBeChecked();
 expect(mocks.saveAppSettings).not.toHaveBeenCalled();
 fireEvent.click(preference);
 expect(draft).toHaveBeenLastCalledWith({ dirty: true, draftRevision: 1 });
 fireEvent.click(screen.getByRole('button', { name: 'Save Settings' }));
 await waitFor(() => expect(mocks.saveAppSettings).toHaveBeenCalledExactlyOnceWith({ autoCheckUpdates: true }));
 await screen.findByText('Application preferences saved');
 expect(mocks.saveSettings).not.toHaveBeenCalled();
 fireEvent.click(preference);
 fireEvent.click(screen.getByRole('button', { name: 'Save Settings' }));
 await waitFor(() => expect(mocks.saveAppSettings).toHaveBeenLastCalledWith({ autoCheckUpdates: false }));
 expect(preference).not.toBeChecked();
});

it('resets auto-check with the normal unsaved defaults and does not bypass startup registration', async () => {
 mocks.getSettings.mockResolvedValue({ ...settings, autoCheckUpdates: false });
 mount();
 expect(await screen.findByLabelText('Automatically check for updates')).not.toBeChecked();
 fireEvent.click(screen.getByRole('button', { name: 'Reset to defaults' }));
 expect(screen.getByLabelText('Automatically check for updates')).toBeChecked();
 expect(mocks.saveAppSettings).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole('button', { name: 'Save Settings' }));
 await waitFor(() => expect(mocks.saveAppSettings).toHaveBeenCalled());
 expect(mocks.saveAppSettings.mock.calls[0][0]).toMatchObject({ autoCheckUpdates: true });
 expect(mocks.saveAppSettings.mock.calls[0][0]).not.toHaveProperty('launchAtLogin');
 expect(mocks.setAutostart).not.toHaveBeenCalled();
});
it('focuses SSH config review reached from diagnostics without automatically previewing or writing', async () => {
 render(<LocaleProvider><ToastProvider><SettingsView initialSection="ssh-config" /></ToastProvider></LocaleProvider>);
 const heading=await screen.findByRole('heading',{name:'SSH Config'});
 await waitFor(()=>expect(heading).toHaveFocus());
 expect(mocks.previewSshConfig).not.toHaveBeenCalled();
 expect(mocks.generateSshConfig).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole('button',{name:'Preview saved SSH config'}));
 await waitFor(()=>expect(mocks.previewSshConfig).toHaveBeenCalledExactlyOnceWith(runtime.scope));
});
it('reports every edit immediately with a new draft revision and saves scoped patch',async()=>{
 const draft=vi.fn(); mount(draft);
 const port=await screen.findByLabelText('Port (1–65535)');
 fireEvent.change(port,{target:{value:'4000'}});
 fireEvent.change(port,{target:{value:'3000'}});
 expect(draft.mock.calls.slice(-2).map(([v])=>v)).toEqual([{dirty:true,draftRevision:1},{dirty:true,draftRevision:2}]);
 fireEvent.click(screen.getByRole('button',{name:'Save Settings'}));
 await waitFor(()=>expect(mocks.saveSettings).toHaveBeenCalledWith({scope:runtime.scope,patch:{port:3000}}));
 await waitFor(()=>expect(draft).toHaveBeenLastCalledWith({dirty:false,draftRevision:2}));
});
it('takes restart warning only from the latest snapshot, including reverting 4000 to 3000',async()=>{
 const view=mount(); await screen.findByLabelText('Host');
 runtime.snapshot={needsRestart:true}; view.rerender(<LocaleProvider><ToastProvider><SettingsView/></ToastProvider></LocaleProvider>);
 expect(screen.getByRole('button',{name:'Restart and apply'})).toBeInTheDocument();
 runtime.snapshot={needsRestart:false}; view.rerender(<LocaleProvider><ToastProvider><SettingsView/></ToastProvider></LocaleProvider>);
 expect(screen.queryByRole('button',{name:'Restart and apply'})).not.toBeInTheDocument();
});
it('does not consume a draft when restart is cancelled',async()=>{
 runtime.snapshot={needsRestart:true}; mocks.restartProxy.mockResolvedValue({cancelled:true});
 const draft=vi.fn(); mount(draft); await screen.findByLabelText('Host');
 fireEvent.change(screen.getByLabelText('Host'),{target:{value:'localhost'}});
 fireEvent.click(screen.getByRole('button',{name:'Restart and apply'}));
 await waitFor(()=>expect(mocks.restartProxy).toHaveBeenCalled());
 expect(draft).toHaveBeenLastCalledWith({dirty:true,draftRevision:1});
 expect(screen.getByLabelText('Host')).toHaveValue('localhost');
});
it('preserves a newer edit while confirmation of an older draft resolves',async()=>{
 runtime.snapshot={needsRestart:true}; let resolve;
 mocks.restartProxy.mockImplementation(()=>new Promise(done=>{resolve=done;}));
 const draft=vi.fn(); mount(draft); const host=await screen.findByLabelText('Host');
 fireEvent.change(host,{target:{value:'localhost'}});
 fireEvent.click(screen.getByRole('button',{name:'Restart and apply'}));
 await waitFor(()=>expect(mocks.restartProxy).toHaveBeenCalled());
 fireEvent.change(host,{target:{value:'127.0.0.2'}});
 await act(async()=>resolve({consumedDraftRevision:1}));
 expect(host).toHaveValue('127.0.0.2'); expect(draft).toHaveBeenLastCalledWith({dirty:true,draftRevision:2});
});
it('never renders saved passwords and sends only explicit replacement',async()=>{
 mount(); const password=await screen.findByLabelText('Password'); expect(password).toHaveValue('');
 fireEvent.change(screen.getByLabelText('USTC ID / GID'),{target:{value:'SA456'}});
 fireEvent.click(screen.getByRole('button',{name:'Save Settings'}));
 await waitFor(()=>expect(mocks.saveSsoCredentials).toHaveBeenCalledWith({scope:runtime.scope,username:'SA456'}));
});

it('commits application and profile patches independently and retries only the failed profile fields',async()=>{
 mocks.saveSettings.mockRejectedValueOnce({code:'SETTINGS_SAVE_FAILED'}).mockResolvedValueOnce({});
 const draft=vi.fn(); mount(draft); await screen.findByLabelText('Host');
 fireEvent.change(screen.getByLabelText('Port (1–65535)'),{target:{value:'4000'}});
 fireEvent.click(screen.getByLabelText('Start minimized to tray'));
 fireEvent.click(screen.getByRole('button',{name:'Save Settings'}));
 await screen.findByText('Application preferences saved');
 expect(mocks.saveSettings).toHaveBeenCalledWith({scope:runtime.scope,patch:{port:4000}});
 expect(mocks.saveAppSettings).toHaveBeenCalledWith({startMinimized:true});
 expect(draft).toHaveBeenLastCalledWith({dirty:true,draftRevision:2});
 fireEvent.click(screen.getByRole('button',{name:'Save Settings'}));
 await waitFor(()=>expect(mocks.saveSettings).toHaveBeenCalledTimes(2));
 await screen.findByText('Profile settings saved');
 expect(mocks.saveAppSettings).toHaveBeenCalledTimes(1);
 expect(draft).toHaveBeenLastCalledWith({dirty:false,draftRevision:2});
});

it('retains app-only dirty fields when the profile commit succeeded and never includes theme, locale, or launchAtLogin',async()=>{
 mocks.saveAppSettings.mockRejectedValueOnce({code:'SETTINGS_SAVE_FAILED'}).mockResolvedValueOnce({});
 mount(); await screen.findByLabelText('Host');
 fireEvent.change(screen.getByLabelText('Port (1–65535)'),{target:{value:'4000'}});
 fireEvent.click(screen.getByLabelText('Start minimized to tray'));
 fireEvent.click(screen.getByRole('button',{name:'Save Settings'}));
 await screen.findByText('Profile settings saved');
 await waitFor(()=>expect(screen.getByRole('button',{name:'Save Settings'})).toBeEnabled());
 fireEvent.click(screen.getByRole('button',{name:'Save Settings'}));
 await screen.findByText('Application preferences saved');
 expect(mocks.saveSettings).toHaveBeenCalledTimes(1);
 expect(mocks.saveAppSettings.mock.calls.map(([patch])=>patch)).toEqual([{startMinimized:true},{startMinimized:true}]);
});

it('preserves credential drafts when the native account change is cancelled',async()=>{
 mocks.saveSsoCredentials.mockResolvedValue({cancelled:true});
 const confirm=vi.spyOn(window,'confirm'); const draft=vi.fn(); mount(draft);
 fireEvent.change(await screen.findByLabelText('USTC ID / GID'),{target:{value:'another-account'}});
 fireEvent.change(screen.getByLabelText('Password'),{target:{value:'new secret'}});
 fireEvent.click(screen.getByRole('button',{name:'Save Settings'}));
 await waitFor(()=>expect(mocks.saveSsoCredentials).toHaveBeenCalled());
 await waitFor(()=>expect(screen.getByRole('button',{name:'Save Settings'})).toBeEnabled());
 expect(screen.getByLabelText('Password')).toHaveValue('new secret');
 expect(draft).toHaveBeenLastCalledWith({dirty:true,draftRevision:2});
 expect(confirm).not.toHaveBeenCalled();
});

it('clears account fields on a profile-keyed page change and rejects late old credentials',async()=>{
 let resolveOld; mocks.getSsoCredentials.mockImplementationOnce(()=>new Promise(resolve=>{resolveOld=resolve;}));
 const view=mount(); await waitFor(()=>expect(mocks.getSsoCredentials).toHaveBeenCalled());
 runtime.scope={profileId:'b',epoch:2};
 mocks.getSsoCredentials.mockResolvedValue({profileId:'b',username:'account-b',hasPassword:false,storageAvailable:true});
 mocks.getSettings.mockResolvedValue({...settings,port:4000});
 view.rerender(<LocaleProvider><ToastProvider><SettingsView key="b"/></ToastProvider></LocaleProvider>);
 expect(await screen.findByLabelText('USTC ID / GID')).toHaveValue('account-b');
 expect(screen.getByLabelText('Password')).toHaveValue('');
 await act(async()=>resolveOld({profileId:'default',username:'old-account',hasPassword:true,storageAvailable:true}));
 expect(screen.getByLabelText('USTC ID / GID')).toHaveValue('account-b');
 expect(screen.queryByText('A password is stored. Enter a new one only to replace it.')).not.toBeInTheDocument();
});

it('shows read-only safe settings when storage is locked even if secrets and keys cannot be loaded',async()=>{
 runtime.snapshot={storageErrorCode:'SETTINGS_INVALID'};
 mocks.getSsoCredentials.mockRejectedValue({code:'SETTINGS_LOCKED',message:'/private/settings-secret.json'});
 mocks.getSshKeyInfo.mockRejectedValue({code:'SSH_KEY_MISSING'});
 mount();
 expect(await screen.findByLabelText('Host')).toHaveValue('127.0.0.1');
 expect(screen.getByLabelText('Host')).toBeDisabled();
 expect(screen.getByRole('button',{name:'Reset to defaults'})).toBeDisabled();
 expect(screen.getByLabelText('Password')).toBeDisabled();
 expect(screen.queryByText('/private/settings-secret.json')).not.toBeInTheDocument();
 expect(mocks.saveSettings).not.toHaveBeenCalled(); expect(mocks.saveAppSettings).not.toHaveBeenCalled();
});

it('refuses another profile credential DTO without making the settings form unavailable',async()=>{
 mocks.getSsoCredentials.mockResolvedValue({profileId:'b',username:'wrong-account',hasPassword:true,storageAvailable:true});
 mount();
 expect(await screen.findByLabelText('Host')).toBeEnabled();
 expect(screen.getByLabelText('USTC ID / GID')).toHaveValue('');
 expect(screen.getByLabelText('USTC ID / GID')).toBeDisabled();
 expect(screen.queryByDisplayValue('wrong-account')).not.toBeInTheDocument();
});

it('clears a replacement password only after a successful scoped credential commit',async()=>{
 mount();
 fireEvent.change(await screen.findByLabelText('Password'),{target:{value:'explicit replacement'}});
 fireEvent.click(screen.getByRole('button',{name:'Save Settings'}));
 await waitFor(()=>expect(mocks.saveSsoCredentials).toHaveBeenCalledWith({scope:runtime.scope,username:'SA123',password:'explicit replacement'}));
 await waitFor(()=>expect(screen.getByLabelText('Password')).toHaveValue(''));
});

it('requires a saved-profile preview and sends only its optimistic tokens when generating',async()=>{
 mocks.previewSshConfig.mockResolvedValue({...preview,content:'Host private-user-config\n  ProxyCommand secret'});
 mocks.generateSshConfig.mockResolvedValue({...preview,changed:false,content:'private-user-config',path:'/tmp/config'});
 const confirm=vi.spyOn(window,'confirm'); mount(); await screen.findByLabelText('Host');
 const generate=screen.getByRole('button',{name:'Generate ~/.ssh/config'});
 expect(generate).toBeDisabled(); expect(mocks.previewSshConfig).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole('button',{name:'Preview saved SSH config'}));
 expect(await screen.findByLabelText('Managed SSH config block preview')).toHaveTextContent('Host usshtc107');
 expect(mocks.previewSshConfig).toHaveBeenCalledExactlyOnceWith(runtime.scope);
 expect(screen.getByText('The managed block will change when generated.')).toBeInTheDocument();
 expect(screen.getByText('/tmp/config.backup')).toBeInTheDocument();
 expect(screen.queryByText(/private-user-config/)).not.toBeInTheDocument();
 fireEvent.click(generate);
 await waitFor(()=>expect(mocks.generateSshConfig).toHaveBeenCalledExactlyOnceWith({scope:runtime.scope,sourceHash:preview.sourceHash,configHash:preview.configHash}));
 await waitFor(()=>expect(generate).toBeDisabled());
 expect(screen.queryByText('/tmp/config',{exact:true})).not.toBeInTheDocument();
 expect(mocks.saveSettings).not.toHaveBeenCalled(); expect(confirm).not.toHaveBeenCalled();
});

it.each([['Host','localhost'],['Port (1–65535)','4000'],['SSH Alias','research'],['Cluster','new-cluster'],['Login Node IP','localhost'],['Starting directory','/work dir'],['Cols (40–500)','120'],['Rows (10–200)','40']])('invalidates the preview after editing %s and requires an explicit save',async(label,value)=>{
 mount(); await screen.findByLabelText('Host');
 fireEvent.click(screen.getByRole('button',{name:'Preview saved SSH config'}));
 await screen.findByLabelText('Managed SSH config block preview');
 fireEvent.change(screen.getByLabelText(label),{target:{value}});
 expect(screen.queryByLabelText('Managed SSH config block preview')).not.toBeInTheDocument();
 expect(screen.getByRole('button',{name:'Preview saved SSH config'})).toBeDisabled();
 expect(screen.getByRole('button',{name:'Generate ~/.ssh/config'})).toBeDisabled();
 expect(screen.getByText(/Draft values are not written automatically/)).toBeInTheDocument();
 expect(mocks.saveSettings).not.toHaveBeenCalled(); expect(mocks.generateSshConfig).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole('button',{name:'Save Settings'}));
 await waitFor(()=>expect(screen.getByRole('button',{name:'Preview saved SSH config'})).toBeEnabled());
 expect(mocks.generateSshConfig).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole('button',{name:'Preview saved SSH config'}));
 await screen.findByLabelText('Managed SSH config block preview');
 expect(mocks.previewSshConfig).toHaveBeenCalledTimes(2);
});

it('does not block saved config preview for unrelated credential or app drafts',async()=>{
 mount(); await screen.findByLabelText('Host');
 fireEvent.change(screen.getByLabelText('Password'),{target:{value:'unsaved password'}});
 fireEvent.click(screen.getByLabelText('Start minimized to tray'));
 fireEvent.click(screen.getByRole('button',{name:'Preview saved SSH config'}));
 await screen.findByLabelText('Managed SSH config block preview');
 expect(mocks.saveSsoCredentials).not.toHaveBeenCalled(); expect(mocks.saveAppSettings).not.toHaveBeenCalled();
 expect(screen.getByRole('button',{name:'Generate ~/.ssh/config'})).toBeEnabled();
});

it('refreshes a changed source or saved-settings preview without automatically retrying the write',async()=>{
 const refreshed={...preview,block:'Host refreshed\n  Port 4000\nHost *\n',sourceHash:'c'.repeat(64),configHash:'d'.repeat(64)};
 mocks.previewSshConfig.mockResolvedValueOnce(preview).mockResolvedValueOnce(refreshed);
 mocks.generateSshConfig.mockRejectedValueOnce({code:'SSH_CONFIG_CHANGED',message:'private config contents'}).mockResolvedValueOnce({...refreshed,changed:false});
 mount(); await screen.findByLabelText('Host');
 fireEvent.click(screen.getByRole('button',{name:'Preview saved SSH config'}));
 await screen.findByLabelText('Managed SSH config block preview');
 fireEvent.click(screen.getByRole('button',{name:'Generate ~/.ssh/config'}));
 await waitFor(()=>expect(screen.getByLabelText('Managed SSH config block preview')).toHaveTextContent('Host refreshed'));
 expect(screen.getByRole('alert')).toHaveTextContent('Review the refreshed preview');
 expect(screen.queryByText('private config contents')).not.toBeInTheDocument();
 expect(mocks.generateSshConfig).toHaveBeenCalledTimes(1);
 fireEvent.click(screen.getByRole('button',{name:'Generate ~/.ssh/config'}));
 await waitFor(()=>expect(mocks.generateSshConfig).toHaveBeenLastCalledWith({scope:runtime.scope,sourceHash:refreshed.sourceHash,configHash:refreshed.configHash}));
});

it('shows pending and fixed preview errors, with an explicit retry and no raw backend message',async()=>{
 let reject; mocks.previewSshConfig.mockImplementationOnce(()=>new Promise((_,fail)=>{reject=fail;}));
 mount(); await screen.findByLabelText('Host');
 fireEvent.click(screen.getByRole('button',{name:'Preview saved SSH config'}));
 expect(screen.getByRole('button',{name:'Loading SSH config preview…'})).toBeDisabled();
 expect(screen.getByRole('button',{name:'Generate ~/.ssh/config'})).toBeDisabled();
 await act(async()=>reject({code:'SSH_ALIAS_CONFLICT',message:'Host confidential-alias'}));
 expect(screen.getByRole('alert')).toHaveTextContent('An unmanaged Host entry already uses this SSH alias');
 expect(screen.queryByText('Host confidential-alias')).not.toBeInTheDocument();
 fireEvent.click(screen.getByRole('button',{name:'Retry SSH config preview'}));
 await screen.findByLabelText('Managed SSH config block preview');
 expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

it('preserves a preview and draft when native generation confirmation is cancelled, without failure or success',async()=>{
 mocks.generateSshConfig.mockResolvedValueOnce({cancelled:true});
 const draft=vi.fn(); const confirm=vi.spyOn(window,'confirm'); mount(draft); await screen.findByLabelText('Host');
 fireEvent.change(screen.getByLabelText('Password'),{target:{value:'keep this draft'}});
 fireEvent.click(screen.getByRole('button',{name:'Preview saved SSH config'}));
 await screen.findByLabelText('Managed SSH config block preview');
 fireEvent.click(screen.getByRole('button',{name:'Generate ~/.ssh/config'}));
 await screen.findByText('Generation cancelled. No changes were made; the preview is still available.');
 expect(screen.getByLabelText('Managed SSH config block preview')).toHaveTextContent('Host usshtc107');
 expect(screen.getByRole('button',{name:'Generate ~/.ssh/config'})).toBeEnabled();
 expect(screen.queryByRole('alert')).not.toBeInTheDocument(); expect(screen.queryByText('SSH config written')).not.toBeInTheDocument();
 expect(screen.getByLabelText('Password')).toHaveValue('keep this draft');
 expect(draft).toHaveBeenLastCalledWith({dirty:true,draftRevision:1}); expect(confirm).not.toHaveBeenCalled();
});

it('invalidates preview on profile or epoch changes and discards an old pending preview',async()=>{
 let resolveOld; mocks.previewSshConfig.mockImplementationOnce(()=>new Promise(resolve=>{resolveOld=resolve;}));
 const view=mount(); await screen.findByLabelText('Host');
 fireEvent.click(screen.getByRole('button',{name:'Preview saved SSH config'}));
 runtime.scope={profileId:'b',epoch:2};
 mocks.getSettings.mockResolvedValue({...settings,port:4000,sshAlias:'profile-b'});
 mocks.getSsoCredentials.mockResolvedValue({profileId:'b',username:'account-b',hasPassword:false,storageAvailable:true});
 view.rerender(<LocaleProvider><ToastProvider><SettingsView/></ToastProvider></LocaleProvider>);
 await waitFor(()=>expect(screen.getByLabelText('SSH Alias')).toHaveValue('profile-b'));
 await act(async()=>resolveOld({...preview,block:'Host old-profile-secret'}));
 expect(screen.queryByText('Host old-profile-secret')).not.toBeInTheDocument();
 expect(screen.getByRole('button',{name:'Generate ~/.ssh/config'})).toBeDisabled();
 fireEvent.click(screen.getByRole('button',{name:'Preview saved SSH config'}));
 await screen.findByLabelText('Managed SSH config block preview');
 expect(mocks.previewSshConfig).toHaveBeenLastCalledWith({profileId:'b',epoch:2});
 runtime.scope={profileId:'b',epoch:3};
 view.rerender(<LocaleProvider><ToastProvider><SettingsView/></ToastProvider></LocaleProvider>);
 await screen.findByLabelText('Host');
 expect(screen.queryByLabelText('Managed SSH config block preview')).not.toBeInTheDocument();
 expect(screen.getByRole('button',{name:'Generate ~/.ssh/config'})).toBeDisabled();
});

it('does not publish an old profile generation result or toast after switching scope',async()=>{
 let resolveWrite; mocks.generateSshConfig.mockImplementationOnce(()=>new Promise(resolve=>{resolveWrite=resolve;}));
 const view=mount(); await screen.findByLabelText('Host');
 fireEvent.click(screen.getByRole('button',{name:'Preview saved SSH config'}));
 await screen.findByLabelText('Managed SSH config block preview');
 fireEvent.click(screen.getByRole('button',{name:'Generate ~/.ssh/config'}));
 runtime.scope={profileId:'b',epoch:2};
 mocks.getSsoCredentials.mockResolvedValue({profileId:'b',username:'account-b',hasPassword:false,storageAvailable:true});
 view.rerender(<LocaleProvider><ToastProvider><SettingsView/></ToastProvider></LocaleProvider>);
 await screen.findByLabelText('Host');
 await act(async()=>resolveWrite({...preview,block:'Host stale-write',backupPath:'/tmp/old-profile-backup'}));
 expect(screen.queryByText('Host stale-write')).not.toBeInTheDocument();
 expect(screen.queryByText('/tmp/old-profile-backup')).not.toBeInTheDocument();
 expect(screen.queryByText('SSH config written')).not.toBeInTheDocument();
 expect(screen.getByRole('button',{name:'Generate ~/.ssh/config'})).toBeDisabled();
});

it('discards a late preview when another connection field is edited while it is pending',async()=>{
 let resolve; mocks.previewSshConfig.mockImplementationOnce(()=>new Promise(done=>{resolve=done;}));
 mount(); await screen.findByLabelText('Host');
 fireEvent.click(screen.getByRole('button',{name:'Preview saved SSH config'}));
 fireEvent.change(screen.getByLabelText('Cluster'),{target:{value:'edited-during-preview'}});
 await act(async()=>resolve(preview));
 expect(screen.queryByLabelText('Managed SSH config block preview')).not.toBeInTheDocument();
 expect(screen.getByRole('button',{name:'Generate ~/.ssh/config'})).toBeDisabled();
 expect(screen.getByRole('button',{name:'Preview saved SSH config'})).toBeDisabled();
});

it('renders unchanged saved config, profile-switch and additive-rule warnings in Chinese',async()=>{
 mocks.getSettings.mockResolvedValue({...settings,locale:'zh'});
 mocks.previewSshConfig.mockResolvedValue({...preview,changed:false,backupPath:null});
 mount(); await screen.findByLabelText('主机');
 fireEvent.click(screen.getByRole('button',{name:'预览已保存的 SSH 配置'}));
 await screen.findByLabelText('受管 SSH 配置块预览');
 expect(screen.getByText('SSH 配置已与此受管块一致，无需更改。')).toBeInTheDocument();
 expect(screen.getByText(/旧别名仍连接本地当前活跃的代理/)).toBeInTheDocument();
 expect(screen.getByText(/IdentityFile 条目可能累加/)).toBeInTheDocument();
 expect(screen.queryByText('/tmp/config.backup')).not.toBeInTheDocument();
});

it('invalidates the preview for root connection changes and reset without implicitly saving',async()=>{
 mount(); await screen.findByLabelText('Host');
 fireEvent.click(screen.getByRole('button',{name:'Preview saved SSH config'}));
 await screen.findByLabelText('Managed SSH config block preview');
 fireEvent.click(screen.getByLabelText('Use Root'));
 expect(screen.queryByLabelText('Managed SSH config block preview')).not.toBeInTheDocument();
 expect(screen.getByRole('button',{name:'Preview saved SSH config'})).toBeDisabled();
 fireEvent.click(screen.getByRole('button',{name:'Reset to defaults'}));
 expect(screen.getByRole('button',{name:'Generate ~/.ssh/config'})).toBeDisabled();
 expect(mocks.saveSettings).not.toHaveBeenCalled(); expect(mocks.generateSshConfig).not.toHaveBeenCalled();
});

it('invalidates a ready preview when saved connection settings change in the current scope',async()=>{
 runtime.snapshot={needsRestart:false,desiredConfig:{host:'127.0.0.1',port:3000}};
 const view=mount(); await screen.findByLabelText('Host');
 fireEvent.click(screen.getByRole('button',{name:'Preview saved SSH config'}));
 await screen.findByLabelText('Managed SSH config block preview');
 runtime.snapshot={needsRestart:true,desiredConfig:{host:'127.0.0.1',port:4000}};
 view.rerender(<LocaleProvider><ToastProvider><SettingsView/></ToastProvider></LocaleProvider>);
 expect(screen.queryByLabelText('Managed SSH config block preview')).not.toBeInTheDocument();
 expect(screen.getByRole('button',{name:'Generate ~/.ssh/config'})).toBeDisabled();
 expect(mocks.generateSshConfig).not.toHaveBeenCalled();
});

it('requires a fresh preview after a generation failure and translates its fixed error',async()=>{
 mocks.generateSshConfig.mockRejectedValueOnce({code:'INTERNAL_ERROR',message:'/private/config'});
 mount(); await screen.findByLabelText('Host');
 fireEvent.click(screen.getByRole('button',{name:'Preview saved SSH config'}));
 await screen.findByLabelText('Managed SSH config block preview');
 fireEvent.click(screen.getByRole('button',{name:'Generate ~/.ssh/config'}));
 expect(await screen.findByRole('alert')).toHaveTextContent('An internal error occurred. Please retry.');
 expect(screen.queryByText('/private/config')).not.toBeInTheDocument();
 expect(screen.getByRole('button',{name:'Generate ~/.ssh/config'})).toBeDisabled();
 fireEvent.click(screen.getByRole('button',{name:'Retry SSH config preview'}));
 await waitFor(()=>expect(screen.getByRole('button',{name:'Generate ~/.ssh/config'})).toBeEnabled());
 expect(mocks.previewSshConfig).toHaveBeenCalledTimes(2);
});

it('never writes again when a changed config cannot be safely re-previewed',async()=>{
 mocks.previewSshConfig.mockResolvedValueOnce(preview).mockRejectedValueOnce({code:'SSH_CONFIG_INVALID',message:'raw malformed source'});
 mocks.generateSshConfig.mockRejectedValueOnce({code:'SSH_CONFIG_CHANGED'});
 mount(); await screen.findByLabelText('Host');
 fireEvent.click(screen.getByRole('button',{name:'Preview saved SSH config'}));
 await screen.findByLabelText('Managed SSH config block preview');
 fireEvent.click(screen.getByRole('button',{name:'Generate ~/.ssh/config'}));
 expect(await screen.findByRole('alert')).toHaveTextContent('The SSH configuration is invalid or unsafe to update.');
 expect(screen.queryByLabelText('Managed SSH config block preview')).not.toBeInTheDocument();
 expect(screen.getByRole('button',{name:'Generate ~/.ssh/config'})).toBeDisabled();
 expect(screen.queryByText('raw malformed source')).not.toBeInTheDocument();
 expect(mocks.generateSshConfig).toHaveBeenCalledTimes(1);
});

it('reads actual startup registration on entry instead of trusting the stored preference and never registers on read',async()=>{
 mocks.getSettings.mockResolvedValue({...settings,launchAtLogin:true});
 const view=mount();
 const checkbox=await screen.findByLabelText('Launch at login');
 await screen.findByText('Disabled in the operating system.');
 expect(checkbox).not.toBeChecked(); expect(mocks.setAutostart).not.toHaveBeenCalled();
 view.unmount();
 mocks.getAutostart.mockResolvedValue({supported:true,enabled:true,approvalRequired:false,errorCode:null});
 mount();
 expect(await screen.findByText('Enabled in the operating system.')).toBeInTheDocument();
 expect(screen.getByLabelText('Launch at login')).toBeChecked();
 expect(mocks.getAutostart).toHaveBeenCalledTimes(2); expect(mocks.setAutostart).not.toHaveBeenCalled();
});

it('applies autostart immediately through the OS API without consuming or saving independent drafts',async()=>{
 const draft=vi.fn(); mount(draft); await screen.findByText('Disabled in the operating system.');
 fireEvent.change(screen.getByLabelText('Host'),{target:{value:'localhost'}});
 fireEvent.click(screen.getByLabelText('Launch at login'));
 await screen.findByText('Enabled in the operating system.');
 expect(mocks.setAutostart).toHaveBeenCalledExactlyOnceWith(true);
 expect(mocks.saveAppSettings).not.toHaveBeenCalled(); expect(mocks.saveSettings).not.toHaveBeenCalled();
 expect(runtime.flushDraft.mock.invocationCallOrder[0]).toBeLessThan(mocks.setAutostart.mock.invocationCallOrder[0]);
 expect(draft).toHaveBeenLastCalledWith({dirty:true,draftRevision:1});
 fireEvent.click(screen.getByRole('button',{name:'Save Settings'}));
 await waitFor(()=>expect(mocks.saveSettings).toHaveBeenCalledWith({scope:runtime.scope,patch:{host:'localhost'}}));
 expect(mocks.saveAppSettings).not.toHaveBeenCalled();
});

it('shows macOS approval as disabled until an explicit refresh observes approval',async()=>{
 mocks.setAutostart.mockResolvedValue({supported:true,enabled:false,approvalRequired:true,errorCode:null});
 mount(); await screen.findByText('Disabled in the operating system.');
 fireEvent.click(screen.getByLabelText('Launch at login'));
 expect(await screen.findByText(/macOS approval is required/)).toBeInTheDocument();
 expect(screen.getByLabelText('Launch at login')).not.toBeChecked();
 mocks.getAutostart.mockResolvedValue({supported:true,enabled:true,approvalRequired:false,errorCode:null});
 fireEvent.click(screen.getByRole('button',{name:'Refresh startup status'}));
 await screen.findByText('Enabled in the operating system.');
 expect(screen.getByLabelText('Launch at login')).toBeChecked(); expect(mocks.setAutostart).toHaveBeenCalledTimes(1);
});

it('explains unavailable development startup and keeps other preference fields editable',async()=>{
 mocks.getAutostart.mockResolvedValue({supported:false,enabled:false,approvalRequired:false,errorCode:'AUTOSTART_UNAVAILABLE'});
 mount();
 await screen.findByText(/Startup registration is unavailable in development/);
 expect(screen.getByLabelText('Launch at login')).toBeDisabled();
 expect(screen.getByLabelText('Recover after sleep or network loss')).toBeEnabled();
 expect(mocks.setAutostart).not.toHaveBeenCalled();
});

it('retries unavailable startup reads and displays only fixed OS errors',async()=>{
 mocks.getAutostart.mockRejectedValueOnce({code:'AUTOSTART_FAILED',message:'/private/startup-path'});
 mount();
 expect(await screen.findByRole('alert')).toHaveTextContent('Startup registration could not be updated or read');
 expect(screen.getByLabelText('Launch at login')).toBeDisabled(); expect(screen.queryByText('/private/startup-path')).not.toBeInTheDocument();
 fireEvent.click(screen.getByRole('button',{name:'Retry startup status'}));
 await screen.findByText('Disabled in the operating system.');
 expect(screen.queryByRole('alert')).not.toBeInTheDocument(); expect(mocks.setAutostart).not.toHaveBeenCalled();
});

it('re-reads the OS state after a rejected startup commit or rollback without changing the requested checkbox optimistically',async()=>{
 mocks.setAutostart.mockRejectedValue({code:'SETTINGS_SAVE_FAILED'});
 mount(); await screen.findByText('Disabled in the operating system.');
 fireEvent.click(screen.getByLabelText('Launch at login'));
 await waitFor(()=>expect(mocks.getAutostart).toHaveBeenCalledTimes(2));
 expect(screen.getByLabelText('Launch at login')).not.toBeChecked();
 expect(await screen.findByRole('button',{name:'Retry startup status'})).toBeEnabled();
 expect(mocks.saveAppSettings).not.toHaveBeenCalled();
});

it('retains drafts and actual startup status after cancellation without a failure notification',async()=>{
 mocks.setAutostart.mockResolvedValue({cancelled:true});
 mount(); await screen.findByText('Disabled in the operating system.');
 fireEvent.change(screen.getByLabelText('Host'),{target:{value:'localhost'}});
 fireEvent.click(screen.getByLabelText('Launch at login'));
 await waitFor(()=>expect(mocks.setAutostart).toHaveBeenCalled());
 await waitFor(()=>expect(screen.getByRole('button',{name:'Refresh startup status'})).toBeEnabled());
 expect(screen.getByLabelText('Launch at login')).not.toBeChecked();
 expect(screen.getByLabelText('Host')).toHaveValue('localhost'); expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

it('ignores a late startup action after a profile epoch change',async()=>{
 let resolve; mocks.setAutostart.mockImplementationOnce(()=>new Promise(done=>{resolve=done;}));
 const view=mount(); await screen.findByText('Disabled in the operating system.');
 fireEvent.click(screen.getByLabelText('Launch at login'));
 await waitFor(()=>expect(mocks.setAutostart).toHaveBeenCalled());
 runtime.scope={profileId:'b',epoch:2};
 mocks.getSsoCredentials.mockResolvedValue({profileId:'b',username:'b',hasPassword:false,storageAvailable:true});
 view.rerender(<LocaleProvider><ToastProvider><SettingsView/></ToastProvider></LocaleProvider>);
 await waitFor(()=>expect(mocks.getAutostart.mock.calls.length).toBeGreaterThanOrEqual(2));
 await act(async()=>resolve({supported:true,enabled:true,approvalRequired:false,errorCode:null}));
 expect(screen.getByLabelText('Launch at login')).not.toBeChecked();
 expect(screen.queryByText('Enabled in the operating system.')).not.toBeInTheDocument();
});

it.each([
 ['Recover after sleep or network loss','reconnectOnResume'],
 ['Notify about new connections','notifyConnections'],
 ['Notify when authentication expires','notifyAuth'],
 ['Notify when the network recovers','notifyRecovery'],
 ['Notify about available updates','notifyUpdates'],
])('persists explicit false and true for %s in independent app patches',async(label,key)=>{
 mount(); const checkbox=await screen.findByLabelText(label); expect(checkbox).toBeChecked();
 fireEvent.click(checkbox); fireEvent.click(screen.getByRole('button',{name:'Save Settings'}));
 await screen.findByText('Application preferences saved');
 expect(mocks.saveAppSettings).toHaveBeenLastCalledWith({[key]:false}); expect(checkbox).not.toBeChecked();
 expect(mocks.saveSettings).not.toHaveBeenCalled(); expect(mocks.setAutostart).not.toHaveBeenCalled();
 await waitFor(()=>expect(checkbox).toBeEnabled());
 fireEvent.click(checkbox); fireEvent.click(screen.getByRole('button',{name:'Save Settings'}));
 await waitFor(()=>expect(mocks.saveAppSettings).toHaveBeenLastCalledWith({[key]:true}));
 expect(checkbox).toBeChecked();
});

it('retains only failed app notification fields after a successful profile save',async()=>{
 mocks.saveAppSettings.mockRejectedValueOnce({code:'SETTINGS_SAVE_FAILED'}).mockResolvedValueOnce({});
 const draft=vi.fn(); mount(draft); await screen.findByLabelText('Host');
 fireEvent.change(screen.getByLabelText('Port (1–65535)'),{target:{value:'4000'}});
 for(const label of ['Notify about new connections','Notify when authentication expires','Notify when the network recovers','Notify about available updates']) fireEvent.click(screen.getByLabelText(label));
 fireEvent.click(screen.getByRole('button',{name:'Save Settings'}));
 await screen.findByText('Profile settings saved');
 await waitFor(()=>expect(screen.getByRole('button',{name:'Save Settings'})).toBeEnabled());
 const patch={notifyConnections:false,notifyAuth:false,notifyRecovery:false,notifyUpdates:false};
 expect(mocks.saveAppSettings).toHaveBeenLastCalledWith(patch);
 expect(draft).toHaveBeenLastCalledWith({dirty:true,draftRevision:5});
 fireEvent.click(screen.getByRole('button',{name:'Save Settings'}));
 await screen.findByText('Application preferences saved');
 expect(mocks.saveSettings).toHaveBeenCalledTimes(1); expect(mocks.saveAppSettings.mock.calls.map(([value])=>value)).toEqual([patch,patch]);
 expect(draft).toHaveBeenLastCalledWith({dirty:false,draftRevision:5});
});

it('localizes OS status, approval and recovery preferences in Chinese',async()=>{
 mocks.getSettings.mockResolvedValue({...settings,locale:'zh'});
 mocks.getAutostart.mockResolvedValue({supported:true,enabled:false,approvalRequired:true,errorCode:null});
 mount();
 expect(await screen.findByRole('heading',{name:'系统偏好与通知'})).toBeInTheDocument();
 expect(screen.getByLabelText('登录系统时启动')).not.toBeChecked();
 expect(await screen.findByText(/需要 macOS 批准/)).toBeInTheDocument();
 expect(screen.getByLabelText('休眠或断网后恢复连接')).toBeChecked();
});

it('keeps startup loading and pending actions accessible without optimistic registration',async()=>{
 let resolveRead,resolveWrite;
 mocks.getAutostart.mockImplementationOnce(()=>new Promise(done=>{resolveRead=done;}));
 mocks.setAutostart.mockImplementationOnce(()=>new Promise(done=>{resolveWrite=done;}));
 const onBusyChange=vi.fn();
 render(<LocaleProvider><ToastProvider><SettingsView onBusyChange={onBusyChange}/></ToastProvider></LocaleProvider>);
 await screen.findByText('Reading operating-system startup status…');
 expect(screen.getByLabelText('Launch at login')).toBeDisabled();
 expect(screen.getByLabelText('Notify about new connections')).toBeEnabled();
 await waitFor(()=>expect(resolveRead).toBeTypeOf('function'));
 await act(async()=>resolveRead({supported:true,enabled:false,approvalRequired:false,errorCode:null}));
 const checkbox=screen.getByLabelText('Launch at login'); checkbox.focus(); expect(checkbox).toHaveFocus();
 fireEvent.click(checkbox);
 await waitFor(()=>expect(mocks.setAutostart).toHaveBeenCalled());
 expect(screen.getByText('Updating operating-system startup registration…')).toBeInTheDocument();
 expect(checkbox).not.toBeChecked(); expect(checkbox).toBeDisabled();
 expect(screen.getByRole('button',{name:'Reset to defaults'})).toBeDisabled();
 expect(onBusyChange).toHaveBeenLastCalledWith(true);
 await act(async()=>resolveWrite({supported:true,enabled:true,approvalRequired:false,errorCode:null}));
 expect(checkbox).toBeChecked(); expect(checkbox).toBeEnabled();
 expect(onBusyChange).toHaveBeenLastCalledWith(false);
});

it('loads persisted false recovery and notification preferences without defaulting them back to true',async()=>{
 mocks.getSettings.mockResolvedValue({...settings,reconnectOnResume:false,notifyConnections:false,notifyAuth:false,notifyRecovery:false,notifyUpdates:false});
 mount();
 await screen.findByLabelText('Recover after sleep or network loss');
 for(const label of ['Recover after sleep or network loss','Notify about new connections','Notify when authentication expires','Notify when the network recovers','Notify about available updates']) expect(screen.getByLabelText(label)).not.toBeChecked();
 expect(screen.getByRole('button',{name:'Save Settings'})).toBeDisabled();
 expect(mocks.saveAppSettings).not.toHaveBeenCalled(); expect(mocks.restartProxy).not.toHaveBeenCalled();
});

it('surfaces an OS startup conflict without exposing paths or saving a desired startup flag',async()=>{
 mocks.getAutostart.mockResolvedValue({supported:true,enabled:false,approvalRequired:false,errorCode:'AUTOSTART_CONFLICT',message:'/private/conflicting.desktop'});
 mount();
 expect(await screen.findByRole('alert')).toHaveTextContent('The startup entry belongs to another application');
 expect(screen.getByLabelText('Launch at login')).toBeDisabled();
 expect(screen.queryByText('/private/conflicting.desktop')).not.toBeInTheDocument();
 expect(screen.getByRole('button',{name:'Retry startup status'})).toBeEnabled();
 expect(mocks.saveAppSettings).not.toHaveBeenCalled(); expect(mocks.setAutostart).not.toHaveBeenCalled();
});

it('loads key information independently so a pending or failed key panel cannot block settings',async()=>{
 let fail; mocks.getSshKeyInfo.mockImplementationOnce(()=>new Promise((_,reject)=>{fail=reject;}));
 mount(); expect(await screen.findByLabelText('Host')).toBeEnabled();
 expect(screen.getByText('Loading SSH key identities…')).toBeInTheDocument();
 fireEvent.change(screen.getByLabelText('Host'),{target:{value:'localhost'}});
 await act(async()=>fail({code:'SSH_KEY_MISSING',message:'private filesystem details'}));
 expect(screen.getByRole('alert')).toHaveTextContent('An existing SSH identity is missing');
 expect(screen.getByLabelText('Host')).toHaveValue('localhost');
 expect(screen.queryByText('private filesystem details')).not.toBeInTheDocument();
 fireEvent.click(screen.getByRole('button',{name:'Retry key information'}));
 await screen.findByText('SHA256:client');
 expect(screen.getByLabelText('Host')).toHaveValue('localhost');
 expect(mocks.getSshKeyInfo).toHaveBeenLastCalledWith(runtime.scope);
});

it('renders application client and host identities without private key contents',async()=>{
 const value={scope:'application',client:{state:'ready',publicKey:'ssh-ed25519 public-only',fingerprint:'SHA256:wire-client',privateKeyPath:'/tmp/client-key',privateKey:'DO NOT DISPLAY PRIVATE KEY'},host:{state:'ready',fingerprint:'SHA256:wire-host',privateKeyPath:'/tmp/host-key',privateKey:'DO NOT DISPLAY HOST SECRET'},recoveryRequired:false};
 mocks.getSshKeyInfo.mockResolvedValue(value); mount();
 await screen.findByText('SHA256:wire-client'); expect(screen.getByText('SHA256:wire-host')).toBeInTheDocument();
 expect(screen.getByText(/shared by every profile/)).toBeInTheDocument();
 expect(screen.getByText('/tmp/client-key')).toBeInTheDocument(); expect(screen.getByText('/tmp/host-key')).toBeInTheDocument();
 expect(screen.queryByText('DO NOT DISPLAY PRIVATE KEY')).not.toBeInTheDocument(); expect(screen.queryByText('DO NOT DISPLAY HOST SECRET')).not.toBeInTheDocument();
 fireEvent.click(screen.getByRole('button',{name:'Copy public key'}));
 await waitFor(()=>expect(mocks.copyToClipboard).toHaveBeenCalledExactlyOnceWith('ssh-ed25519 public-only'));
 expect(screen.getByLabelText('Keys to replace')).toHaveValue('client');
});

it.each(['backup','import','rotate'])('keeps key information, password and drafts when %s is cancelled by the system',async(kind)=>{
 const methods={backup:mocks.exportKeyBackup,import:mocks.importKeyBackup,rotate:mocks.rotateSshKeys};
 const labels={backup:'Export encrypted key backup',import:'Import encrypted key backup',rotate:'Rotate selected keys'};
 methods[kind].mockResolvedValue({cancelled:true});
 const draft=vi.fn(); const confirm=vi.spyOn(window,'confirm'); mount(draft);
 await screen.findByText('SHA256:client');
 fireEvent.change(screen.getByLabelText('Host'),{target:{value:'localhost'}});
 fireEvent.change(screen.getByLabelText('Password'),{target:{value:'keep replacement password'}});
 fireEvent.click(screen.getByRole('button',{name:labels[kind]}));
 await screen.findByText('Cancelled. The current keys and unsaved changes were kept.');
 expect(methods[kind]).toHaveBeenCalledExactlyOnceWith(kind==='rotate'?{scope:runtime.scope,target:'client'}:runtime.scope);
 expect(runtime.flushDraft.mock.invocationCallOrder[0]).toBeLessThan(methods[kind].mock.invocationCallOrder[0]);
 expect(screen.getByText('SHA256:client')).toBeInTheDocument(); expect(screen.getByLabelText('Host')).toHaveValue('localhost');
 expect(screen.getByLabelText('Password')).toHaveValue('keep replacement password');
 expect(draft).toHaveBeenLastCalledWith({dirty:true,draftRevision:2});
 expect(mocks.getSshKeyInfo).toHaveBeenCalledTimes(1); expect(confirm).not.toHaveBeenCalled();
});

it('disables encrypted actions when OS secure storage is unavailable and explains binding limits',async()=>{
 mocks.getSsoCredentials.mockResolvedValue({profileId:'default',username:'SA123',hasPassword:false,storageAvailable:false});
 mount(); await screen.findByText('SHA256:client');
 expect(screen.getByRole('button',{name:'Export encrypted key backup'})).toBeDisabled();
 expect(screen.getByRole('button',{name:'Import encrypted key backup'})).toBeDisabled();
 expect(screen.getByRole('button',{name:'Rotate selected keys'})).toBeDisabled();
 expect(screen.getByText(/Losing the original OS keyring can make a backup unrecoverable/)).toBeInTheDocument();
 expect(screen.getByText(/OS secure storage is unavailable or could not be verified/)).toBeInTheDocument();
 expect(screen.getByLabelText('Host')).toBeEnabled(); expect(mocks.exportKeyBackup).not.toHaveBeenCalled();
});

it('shows host trust consequences and forwards selected host or both targets without browser confirmation',async()=>{
 mocks.rotateSshKeys.mockResolvedValue({cancelled:true});
 const confirm=vi.spyOn(window,'confirm'); mount(); await screen.findByText('SHA256:host');
 expect(screen.queryByText(/The system confirmation will show the actual old and new fingerprints/)).not.toBeInTheDocument();
 fireEvent.change(screen.getByLabelText('Keys to replace'),{target:{value:'host'}});
 expect(screen.getByText(/The system confirmation will show the actual old and new fingerprints/)).toBeInTheDocument();
 expect(screen.getByText(/never changes known_hosts or bypasses host-key checks/)).toBeInTheDocument();
 fireEvent.click(screen.getByRole('button',{name:'Rotate selected keys'}));
 await screen.findByText('Cancelled. The current keys and unsaved changes were kept.');
 expect(mocks.rotateSshKeys).toHaveBeenLastCalledWith({scope:runtime.scope,target:'host'});
 fireEvent.change(screen.getByLabelText('Keys to replace'),{target:{value:'both'}});
 fireEvent.click(screen.getByRole('button',{name:'Rotate selected keys'}));
 await waitFor(()=>expect(mocks.rotateSshKeys).toHaveBeenLastCalledWith({scope:runtime.scope,target:'both'}));
 expect(confirm).not.toHaveBeenCalled(); expect(mocks.exportKeyBackup).not.toHaveBeenCalled();
});

it('offers explicit rebuild for missing and invalid keys without automatically recreating them',async()=>{
 mocks.getSshKeyInfo.mockResolvedValue({scope:'application',client:{state:'missing',publicKey:null,fingerprint:null,privateKeyPath:'/tmp/key'},host:{state:'invalid',fingerprint:null,privateKeyPath:'/tmp/host'},recoveryRequired:true});
 mocks.rebuildSshKeys.mockResolvedValue({cancelled:true}); mount();
 await screen.findByText('Missing'); expect(screen.getByText('Invalid')).toBeInTheDocument();
 expect(screen.getByRole('button',{name:'Rotate selected keys'})).toBeDisabled();
 expect(screen.getByRole('button',{name:'Rebuild selected keys'})).toBeEnabled();
 expect(screen.getByText(/missing or invalid keys are never recreated automatically/)).toBeInTheDocument();
 expect(mocks.rebuildSshKeys).not.toHaveBeenCalled();
 fireEvent.change(screen.getByLabelText('Keys to replace'),{target:{value:'host'}});
 fireEvent.click(screen.getByRole('button',{name:'Rebuild selected keys'}));
 await waitFor(()=>expect(mocks.rebuildSshKeys).toHaveBeenCalledExactlyOnceWith({scope:runtime.scope,target:'host'}));
});

it('refreshes keys and runtime after success without clearing drafts absent a consumed revision',async()=>{
 mocks.exportKeyBackup.mockResolvedValue({scope:runtime.scope}); const draft=vi.fn(); mount(draft);
 await screen.findByText('SHA256:client');
 fireEvent.change(screen.getByLabelText('Password'),{target:{value:'unsaved password'}});
 fireEvent.click(screen.getByRole('button',{name:'Export encrypted key backup'}));
 await screen.findByText('Encrypted key backup exported.');
 expect(mocks.getSshKeyInfo).toHaveBeenCalledTimes(2); expect(runtime.retry).toHaveBeenCalledTimes(1);
 expect(screen.getByLabelText('Password')).toHaveValue('unsaved password'); expect(draft).toHaveBeenLastCalledWith({dirty:true,draftRevision:1});
});

it('clears only the exact draft revision consumed by a successful key operation',async()=>{
 mocks.importKeyBackup.mockResolvedValue({scope:runtime.scope,consumedDraftRevision:2}); const draft=vi.fn(); mount(draft);
 await screen.findByText('SHA256:client');
 fireEvent.change(screen.getByLabelText('Host'),{target:{value:'localhost'}});
 fireEvent.change(screen.getByLabelText('Password'),{target:{value:'old draft password'}});
 fireEvent.click(screen.getByRole('button',{name:'Import encrypted key backup'}));
 await waitFor(()=>expect(screen.getByLabelText('Host')).toHaveValue('127.0.0.1'));
 expect(screen.getByLabelText('Password')).toHaveValue(''); expect(draft).toHaveBeenLastCalledWith({dirty:false,draftRevision:2});
});

it('keeps newer drafts edited while the key confirmation for an older revision is pending',async()=>{
 let finish; mocks.rotateSshKeys.mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
 const draft=vi.fn(); mount(draft); await screen.findByText('SHA256:client');
 fireEvent.change(screen.getByLabelText('Host'),{target:{value:'localhost'}});
 fireEvent.click(screen.getByRole('button',{name:'Rotate selected keys'}));
 await waitFor(()=>expect(mocks.rotateSshKeys).toHaveBeenCalled());
 fireEvent.change(screen.getByLabelText('Password'),{target:{value:'newer draft'}});
 await act(async()=>finish({scope:runtime.scope,consumedDraftRevision:1}));
 await screen.findByText('Key operation completed. Key information has been refreshed.');
 expect(screen.getByLabelText('Host')).toHaveValue('localhost'); expect(screen.getByLabelText('Password')).toHaveValue('newer draft');
 expect(draft).toHaveBeenLastCalledWith({dirty:true,draftRevision:2});
});

it('rejects stale key reads after scope changes and retains only the current application DTO',async()=>{
 let finish; mocks.getSshKeyInfo.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
 const view=mount(); await screen.findByLabelText('Host');
 runtime.scope={profileId:'b',epoch:2}; mocks.getSsoCredentials.mockResolvedValue({profileId:'b',username:'B',storageAvailable:true});
 mocks.getSshKeyInfo.mockResolvedValue({scope:'application',client:{state:'ready',publicKey:'ssh-ed25519 current',fingerprint:'SHA256:new-client',privateKeyPath:'/tmp/new'},host:{state:'ready',fingerprint:'SHA256:new-host',privateKeyPath:'/tmp/new-host'},recoveryRequired:false});
 view.rerender(<LocaleProvider><ToastProvider><SettingsView key="b"/></ToastProvider></LocaleProvider>);
 await screen.findByText('SHA256:new-client');
 await act(async()=>finish({scope:'application',client:{state:'ready',fingerprint:'SHA256:stale',publicKey:'ssh-ed25519 stale'},host:{state:'ready'},recoveryRequired:false}));
 expect(screen.queryByText('SHA256:stale')).not.toBeInTheDocument(); expect(screen.getByText('SHA256:new-client')).toBeInTheDocument();
});

it('rejects a stale operation result after another profile takes ownership',async()=>{
 let finish; mocks.importKeyBackup.mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
 const view=mount(); await screen.findByText('SHA256:client');
 fireEvent.click(screen.getByRole('button',{name:'Import encrypted key backup'})); await waitFor(()=>expect(mocks.importKeyBackup).toHaveBeenCalled());
 const oldScope=runtime.scope; runtime.scope={profileId:'b',epoch:2}; mocks.getSsoCredentials.mockResolvedValue({profileId:'b',username:'B',storageAvailable:true});
 view.rerender(<LocaleProvider><ToastProvider><SettingsView key="b"/></ToastProvider></LocaleProvider>);
 await screen.findByLabelText('Host'); await act(async()=>finish({scope:oldScope,consumedDraftRevision:0}));
 expect(runtime.retry).not.toHaveBeenCalled(); expect(screen.queryByText('Key operation completed. Key information has been refreshed.')).not.toBeInTheDocument();
});

it('does not enter a key action until the draft acknowledgement completes, and rejects a changed scope',async()=>{
 let acknowledge; runtime.flushDraft.mockImplementation(()=>new Promise(resolve=>{acknowledge=resolve;}));
 mount(); await screen.findByText('SHA256:client');
 fireEvent.click(screen.getByRole('button',{name:'Rotate selected keys'}));
 expect(mocks.rotateSshKeys).not.toHaveBeenCalled(); runtime.scope={profileId:'other',epoch:2};
 await act(async()=>acknowledge()); expect(mocks.rotateSshKeys).not.toHaveBeenCalled();
});

it('renders translated key states and backup/trust guidance in Chinese',async()=>{
 mocks.getSettings.mockResolvedValue({...settings,locale:'zh'}); mount(); await screen.findByRole('heading',{name:'应用 SSH 密钥'});
 await screen.findByText('SHA256:client');
 expect(screen.getByText(/原系统密钥环丢失后/)).toBeInTheDocument();
 fireEvent.change(screen.getByLabelText('要替换的密钥'),{target:{value:'host'}});
 expect(screen.getByText(/系统确认将显示实际的新旧指纹/)).toBeInTheDocument();
 expect(screen.getByRole('button',{name:'轮换所选密钥'})).toBeEnabled();
});

it('accepts the action-owned execution scope after a key operation advances the epoch',async()=>{
 let finish; mocks.rotateSshKeys.mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
 const draft=vi.fn(); const view=mount(draft); await screen.findByText('SHA256:client');
 fireEvent.change(screen.getByLabelText('Host'),{target:{value:'localhost'}});
 fireEvent.click(screen.getByRole('button',{name:'Rotate selected keys'})); await waitFor(()=>expect(mocks.rotateSshKeys).toHaveBeenCalled());
 runtime.scope={profileId:'default',epoch:2};
 view.rerender(<LocaleProvider><ToastProvider><SettingsView onDraftChange={draft}/></ToastProvider></LocaleProvider>);
 await act(async()=>finish({scope:runtime.scope,consumedDraftRevision:1}));
 await waitFor(()=>expect(draft).toHaveBeenLastCalledWith({dirty:false,draftRevision:1}));
 expect(mocks.getSshKeyInfo).toHaveBeenLastCalledWith({profileId:'default',epoch:2});
 expect(screen.getByLabelText('Host')).toHaveValue('127.0.0.1');
});

it.each([undefined,{}, {scope:{profileId:'default'}}, {scope:{profileId:'default',epoch:'1'}}])('rejects a replacement result missing its valid execution scope: %j',async(result)=>{
 mocks.importKeyBackup.mockResolvedValue(result); const draft=vi.fn(); mount(draft); await screen.findByText('SHA256:client');
 fireEvent.change(screen.getByLabelText('Password'),{target:{value:'keep draft'}});
 fireEvent.click(screen.getByRole('button',{name:'Import encrypted key backup'}));
 expect(await screen.findByRole('alert')).toHaveTextContent('The application API is unavailable. Please restart.');
 expect(screen.getByLabelText('Password')).toHaveValue('keep draft'); expect(draft).toHaveBeenLastCalledWith({dirty:true,draftRevision:1});
 expect(screen.queryByText('Key operation completed. Key information has been refreshed.')).not.toBeInTheDocument();
});

it.each(['SSH_KEY_MISSING','SSH_KEY_INVALID','SSH_KEY_FINGERPRINT_MISMATCH','KEY_BACKUP_INVALID','KEY_TRANSACTION_FAILED','KEY_ROLLBACK_FAILED','SECURE_STORAGE_UNAVAILABLE'])('keeps a key failure confined to its panel with safe %s guidance',async(code)=>{
 mocks.importKeyBackup.mockRejectedValue({code,message:'BEGIN PRIVATE KEY confidential material'});
 const draft=vi.fn(); mount(draft); await screen.findByText('SHA256:client');
 fireEvent.change(screen.getByLabelText('Host'),{target:{value:'localhost'}});
 fireEvent.click(screen.getByRole('button',{name:'Import encrypted key backup'}));
 await screen.findByRole('alert');
 expect(screen.getByLabelText('Host')).toBeEnabled(); expect(screen.getByLabelText('Host')).toHaveValue('localhost');
 expect(screen.queryByText(/BEGIN PRIVATE KEY/)).not.toBeInTheDocument();
 expect(draft).toHaveBeenLastCalledWith({dirty:true,draftRevision:1}); expect(screen.getByText('SHA256:client')).toBeInTheDocument();
});

it('allows explicit missing-key rebuild without OS storage, but does not offer rotation or a false backup',async()=>{
 mocks.getSsoCredentials.mockResolvedValue({profileId:'default',username:'SA123',storageAvailable:false});
 mocks.getSshKeyInfo.mockResolvedValue({scope:'application',client:{state:'missing',publicKey:null,fingerprint:null,privateKeyPath:'/tmp/key'},host:{state:'changed',fingerprint:'SHA256:unexpected',privateKeyPath:'/tmp/host'},recoveryRequired:true});
 mocks.rebuildSshKeys.mockResolvedValue({cancelled:true}); mount(); await screen.findByText('Fingerprint changed');
 expect(screen.getByRole('button',{name:'Rebuild selected keys'})).toBeEnabled();
 fireEvent.click(screen.getByRole('button',{name:'Rebuild selected keys'}));
 await waitFor(()=>expect(mocks.rebuildSshKeys).toHaveBeenCalledExactlyOnceWith({scope:runtime.scope,target:'client'}));
 expect(mocks.exportKeyBackup).not.toHaveBeenCalled(); expect(mocks.rotateSshKeys).not.toHaveBeenCalled();
});

it('rejects the obsolete flat key DTO without making settings unavailable',async()=>{
 mocks.getSshKeyInfo.mockResolvedValue({publicKey:'ssh-ed25519 obsolete',privateKeyPath:'/tmp/obsolete'});
 mount(); expect(await screen.findByLabelText('Host')).toBeEnabled();
 expect(await screen.findByRole('alert')).toHaveTextContent('The application API is unavailable. Please restart.');
 expect(screen.queryByText('ssh-ed25519 obsolete')).not.toBeInTheDocument();
 expect(screen.getByRole('button',{name:'Retry key information'})).toBeEnabled();
});

it('explains both-key rebuild as repair that preserves the ready identity and forwards both explicitly',async()=>{
 mocks.getSsoCredentials.mockResolvedValue({profileId:'default',username:'SA123',storageAvailable:false});
 mocks.getSshKeyInfo.mockResolvedValue({scope:'application',client:{state:'missing',publicKey:null,fingerprint:null,privateKeyPath:'/tmp/key'},host:{state:'ready',fingerprint:'SHA256:retained-host',privateKeyPath:'/tmp/host'},recoveryRequired:true});
 mocks.rebuildSshKeys.mockResolvedValue({cancelled:true}); mount(); await screen.findByText('SHA256:retained-host');
 fireEvent.change(screen.getByLabelText('Keys to replace'),{target:{value:'both'}});
 expect(screen.getByText(/selected ready keys are kept unchanged, even when both keys are selected/)).toBeInTheDocument();
 expect(screen.getByText(/Missing or invalid old key material cannot be backed up/)).toBeInTheDocument();
 expect(screen.getByRole('button',{name:'Rebuild selected keys'})).toBeEnabled();
 fireEvent.click(screen.getByRole('button',{name:'Rebuild selected keys'}));
 await waitFor(()=>expect(mocks.rebuildSshKeys).toHaveBeenCalledExactlyOnceWith({scope:runtime.scope,target:'both'}));
 expect(mocks.exportKeyBackup).not.toHaveBeenCalled(); expect(mocks.rotateSshKeys).not.toHaveBeenCalled();
});

const readyKeysNeedingRecovery={scope:'application',client:{state:'ready',publicKey:'ssh-ed25519 retained',fingerprint:'SHA256:retained-client',privateKeyPath:'/tmp/key'},host:{state:'ready',fingerprint:'SHA256:retained-host',privateKeyPath:'/tmp/host'},recoveryRequired:true};

it('offers metadata and journal recovery, not rebuilding ready keys, even while root settings are locked',async()=>{
 runtime.snapshot={storageErrorCode:'KEY_ROLLBACK_FAILED'};
 mocks.getSshKeyInfo.mockResolvedValue(readyKeysNeedingRecovery); mount();
 await screen.findByText('SHA256:retained-client');
 expect(screen.getByText(/Both key files are ready, but key metadata or an interrupted transaction still needs recovery/)).toBeInTheDocument();
 expect(screen.getByRole('button',{name:'Retry key recovery'})).toBeEnabled();
 expect(screen.queryByRole('button',{name:'Rebuild selected keys'})).not.toBeInTheDocument();
 expect(screen.queryByRole('button',{name:'Rotate selected keys'})).not.toBeInTheDocument();
 expect(screen.getByRole('button',{name:'Import encrypted key backup'})).toBeDisabled();
 expect(screen.getByLabelText('Host')).toBeDisabled();
 expect(mocks.rebuildSshKeys).not.toHaveBeenCalled();
});

it('acknowledges drafts before native recovery cancellation and keeps current keys, password and form values',async()=>{
 mocks.getSshKeyInfo.mockResolvedValue(readyKeysNeedingRecovery);
 mocks.retryLoadSettings.mockResolvedValue({cancelled:true}); const draft=vi.fn(); const confirm=vi.spyOn(window,'confirm'); mount(draft);
 await screen.findByText('SHA256:retained-client');
 fireEvent.change(screen.getByLabelText('Host'),{target:{value:'localhost'}});
 fireEvent.change(screen.getByLabelText('Password'),{target:{value:'keep recovery draft'}});
 fireEvent.click(screen.getByRole('button',{name:'Retry key recovery'}));
 await screen.findByText('Cancelled. The current keys and unsaved changes were kept.');
 expect(mocks.retryLoadSettings).toHaveBeenCalledExactlyOnceWith(runtime.scope);
 expect(runtime.flushDraft.mock.invocationCallOrder[0]).toBeLessThan(mocks.retryLoadSettings.mock.invocationCallOrder[0]);
 expect(screen.getByLabelText('Host')).toHaveValue('localhost'); expect(screen.getByLabelText('Password')).toHaveValue('keep recovery draft');
 expect(screen.getByText('SHA256:retained-client')).toBeInTheDocument();
 expect(draft).toHaveBeenLastCalledWith({dirty:true,draftRevision:2}); expect(runtime.retry).not.toHaveBeenCalled(); expect(confirm).not.toHaveBeenCalled();
});

it('uses settings reload success without a key-replacement scope and refreshes the new current scope before consuming its matching draft',async()=>{
 mocks.getSshKeyInfo.mockResolvedValue(readyKeysNeedingRecovery);
 mocks.retryLoadSettings.mockResolvedValue({activeProfileId:'default',profiles:[],consumedDraftRevision:2});
 runtime.retry.mockImplementation(async()=>{runtime.scope={profileId:'default',epoch:2};});
 const draft=vi.fn(); mount(draft); await screen.findByText('SHA256:retained-client');
 fireEvent.change(screen.getByLabelText('Host'),{target:{value:'localhost'}});
 fireEvent.change(screen.getByLabelText('Password'),{target:{value:'old recovery draft'}});
 fireEvent.click(screen.getByRole('button',{name:'Retry key recovery'}));
 await waitFor(()=>expect(draft).toHaveBeenLastCalledWith({dirty:false,draftRevision:2}));
 expect(mocks.getSshKeyInfo).toHaveBeenLastCalledWith({profileId:'default',epoch:2});
 expect(runtime.retry.mock.invocationCallOrder[0]).toBeLessThan(mocks.getSshKeyInfo.mock.invocationCallOrder[1]);
 expect(screen.getByLabelText('Host')).toHaveValue('127.0.0.1'); expect(screen.getByLabelText('Password')).toHaveValue('');
});

it('retains newer drafts when recovery confirmation consumed an older revision',async()=>{
 mocks.getSshKeyInfo.mockResolvedValue(readyKeysNeedingRecovery);
 let finish; mocks.retryLoadSettings.mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
 const draft=vi.fn(); mount(draft); await screen.findByText('SHA256:retained-client');
 fireEvent.change(screen.getByLabelText('Host'),{target:{value:'localhost'}});
 fireEvent.click(screen.getByRole('button',{name:'Retry key recovery'})); await waitFor(()=>expect(mocks.retryLoadSettings).toHaveBeenCalled());
 fireEvent.change(screen.getByLabelText('Password'),{target:{value:'newer recovery draft'}});
 await act(async()=>finish({activeProfileId:'default',profiles:[],consumedDraftRevision:1}));
 await screen.findByText('Key recovery reload completed. Key information has been refreshed.');
 expect(screen.getByLabelText('Host')).toHaveValue('localhost'); expect(screen.getByLabelText('Password')).toHaveValue('newer recovery draft');
 expect(draft).toHaveBeenLastCalledWith({dirty:true,draftRevision:2});
});

it('preserves key and journal materials in recovery error guidance and allows retry without rebuilding',async()=>{
 mocks.getSshKeyInfo.mockResolvedValue(readyKeysNeedingRecovery);
 mocks.retryLoadSettings.mockRejectedValue({code:'KEY_ROLLBACK_FAILED',message:'confidential journal path'});
 const draft=vi.fn(); mount(draft); await screen.findByText('SHA256:retained-client');
 fireEvent.change(screen.getByLabelText('Password'),{target:{value:'keep failed recovery draft'}});
 fireEvent.click(screen.getByRole('button',{name:'Retry key recovery'}));
 expect(await screen.findByRole('alert')).toHaveTextContent('Preserve all key and transaction materials');
 expect(screen.getByRole('alert')).toHaveTextContent('Do not rebuild over an unresolved transaction');
 expect(screen.queryByText('confidential journal path')).not.toBeInTheDocument();
 expect(screen.getByRole('button',{name:'Retry key recovery'})).toBeEnabled(); expect(screen.getByLabelText('Password')).toHaveValue('keep failed recovery draft');
 expect(draft).toHaveBeenLastCalledWith({dirty:true,draftRevision:1}); expect(mocks.rebuildSshKeys).not.toHaveBeenCalled();
});

it('rejects a late recovery result after profile ownership changes without refreshing or consuming the new profile draft',async()=>{
 mocks.getSshKeyInfo.mockResolvedValue(readyKeysNeedingRecovery);
 let finish; mocks.retryLoadSettings.mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
 const view=mount(); await screen.findByText('SHA256:retained-client');
 fireEvent.click(screen.getByRole('button',{name:'Retry key recovery'})); await waitFor(()=>expect(mocks.retryLoadSettings).toHaveBeenCalled());
 runtime.scope={profileId:'b',epoch:2}; mocks.getSsoCredentials.mockResolvedValue({profileId:'b',username:'B',storageAvailable:true});
 const draft=vi.fn(); view.rerender(<LocaleProvider><ToastProvider><SettingsView key="b" onDraftChange={draft}/></ToastProvider></LocaleProvider>);
 await screen.findByText('SHA256:retained-client'); fireEvent.change(screen.getByLabelText('Password'),{target:{value:'profile B draft'}});
 await act(async()=>finish({activeProfileId:'default',profiles:[],consumedDraftRevision:1}));
 expect(runtime.retry).not.toHaveBeenCalled(); expect(screen.getByLabelText('Password')).toHaveValue('profile B draft');
 expect(draft).toHaveBeenLastCalledWith({dirty:true,draftRevision:1});
 expect(screen.queryByText('Key recovery reload completed. Key information has been refreshed.')).not.toBeInTheDocument();
});

it('drops a delayed key failure after an unrelated same-profile epoch change without altering its state',async()=>{
 let fail; mocks.importKeyBackup.mockImplementation(()=>new Promise((_,reject)=>{fail=reject;}));
 const draft=vi.fn(); const view=mount(draft); await screen.findByText('SHA256:client');
 fireEvent.change(screen.getByLabelText('Password'),{target:{value:'keep current draft'}});
 fireEvent.click(screen.getByRole('button',{name:'Import encrypted key backup'})); await waitFor(()=>expect(mocks.importKeyBackup).toHaveBeenCalled());
 runtime.scope={profileId:'default',epoch:2}; runtime.snapshot={operation:'stopping',errorCode:null};
 view.rerender(<LocaleProvider><ToastProvider><SettingsView onDraftChange={draft}/></ToastProvider></LocaleProvider>);
 await screen.findByText('SHA256:client');
 await act(async()=>fail({code:'KEY_TRANSACTION_FAILED'}));
 expect(screen.queryByRole('alert')).not.toBeInTheDocument(); expect(screen.getByLabelText('Password')).toHaveValue('keep current draft');
 expect(draft).toHaveBeenLastCalledWith({dirty:true,draftRevision:1});
});

it('keeps an own-epoch key failure visible when the latest authoritative snapshot records that exact failure',async()=>{
 let fail; mocks.rotateSshKeys.mockImplementation(()=>new Promise((_,reject)=>{fail=reject;}));
 const draft=vi.fn(); const view=mount(draft); await screen.findByText('SHA256:client');
 fireEvent.change(screen.getByLabelText('Password'),{target:{value:'own operation draft'}});
 fireEvent.click(screen.getByRole('button',{name:'Rotate selected keys'})); await waitFor(()=>expect(mocks.rotateSshKeys).toHaveBeenCalled());
 runtime.scope={profileId:'default',epoch:2}; runtime.snapshot={operation:null,errorCode:'KEY_TRANSACTION_FAILED'};
 view.rerender(<LocaleProvider><ToastProvider><SettingsView onDraftChange={draft}/></ToastProvider></LocaleProvider>);
 await act(async()=>fail({code:'KEY_TRANSACTION_FAILED'}));
 expect(await screen.findByRole('alert')).toHaveTextContent('Preserve the key and transaction files');
 expect(screen.getByLabelText('Password')).toHaveValue('own operation draft'); expect(draft).toHaveBeenLastCalledWith({dirty:true,draftRevision:1});
});

it('rechecks failure ownership after runtime refresh before reading or setting a key error in a newer epoch',async()=>{
 let finishRetry; runtime.retry.mockImplementation(()=>new Promise(resolve=>{finishRetry=resolve;}));
 mocks.importKeyBackup.mockRejectedValue({code:'KEY_TRANSACTION_FAILED'});
 const view=mount(); await screen.findByText('SHA256:client');
 fireEvent.change(screen.getByLabelText('Password'),{target:{value:'newer operation draft'}});
 fireEvent.click(screen.getByRole('button',{name:'Import encrypted key backup'})); await waitFor(()=>expect(runtime.retry).toHaveBeenCalled());
 runtime.scope={profileId:'default',epoch:2}; runtime.snapshot={operation:'starting',errorCode:null};
 view.rerender(<LocaleProvider><ToastProvider><SettingsView/></ToastProvider></LocaleProvider>);
 await screen.findByText('SHA256:client');
 await act(async()=>finishRetry());
 expect(screen.queryByRole('alert')).not.toBeInTheDocument();
 expect(screen.getByLabelText('Password')).toHaveValue('newer operation draft');
});

it('refreshes authoritative status when a key failure reply beats the final runtime event and shows rolled-back identities',async()=>{
 const original={scope:'application',client:{state:'ready',publicKey:'ssh-ed25519 test',fingerprint:'SHA256:client',privateKeyPath:'/tmp/key'},host:{state:'ready',fingerprint:'SHA256:host',privateKeyPath:'/tmp/host'},recoveryRequired:false};
 let keySnapshot=original;
 mocks.getSshKeyInfo.mockImplementation(async()=>keySnapshot);
 let fail; mocks.rotateSshKeys.mockImplementation(()=>new Promise((_,reject)=>{fail=reject;}));
 const draft=vi.fn();const view=mount(draft);await screen.findByText('SHA256:client');
 fireEvent.change(screen.getByLabelText('Password'),{target:{value:'preserve failed draft'}});
 fireEvent.click(screen.getByRole('button',{name:'Rotate selected keys'}));
 await waitFor(()=>expect(mocks.rotateSshKeys).toHaveBeenCalled());
 runtime.scope={profileId:'default',epoch:2};runtime.snapshot={operation:'changing_keys',errorCode:null};
 keySnapshot={...original,host:{...original.host,state:'changed',fingerprint:'SHA256:candidate'},recoveryRequired:true};
 view.rerender(<LocaleProvider><ToastProvider><SettingsView onDraftChange={draft}/></ToastProvider></LocaleProvider>);
 await screen.findByText('SHA256:candidate');
 runtime.retry.mockImplementation(async()=>{runtime.snapshot={operation:null,errorCode:'KEY_TRANSACTION_FAILED'};keySnapshot=original;});
 await act(async()=>fail({code:'KEY_TRANSACTION_FAILED'}));
 expect(await screen.findByRole('alert')).toHaveTextContent('Preserve the key and transaction files');
 expect(screen.getByText('SHA256:host')).toBeInTheDocument();
 expect(screen.queryByText('SHA256:candidate')).not.toBeInTheDocument();
 expect(screen.getByLabelText('Password')).toHaveValue('preserve failed draft');
 expect(draft).toHaveBeenLastCalledWith({dirty:true,draftRevision:1});
});

it('keeps a clean-form key action mounted across its epoch and preserves its error after a background settings read',async()=>{
 let fail; mocks.rotateSshKeys.mockImplementation(()=>new Promise((_,reject)=>{fail=reject;}));
 const view=mount();await screen.findByText('SHA256:client');
 fireEvent.click(screen.getByRole('button',{name:'Rotate selected keys'}));
 await waitFor(()=>expect(mocks.rotateSshKeys).toHaveBeenCalled());
 let finishSettings;mocks.getSettings.mockImplementationOnce(()=>new Promise(resolve=>{finishSettings=resolve;}));
 runtime.scope={profileId:'default',epoch:2};runtime.snapshot={operation:'changing_keys',errorCode:null};
 view.rerender(<LocaleProvider><ToastProvider><SettingsView/></ToastProvider></LocaleProvider>);
 expect(screen.getByRole('heading',{name:'Application SSH keys'})).toBeInTheDocument();
 await waitFor(()=>expect(finishSettings).toBeTypeOf('function'));
 runtime.retry.mockImplementation(async()=>{runtime.snapshot={operation:null,errorCode:'KEY_TRANSACTION_FAILED'};});
 await act(async()=>fail({code:'KEY_TRANSACTION_FAILED'}));
 expect(await screen.findByRole('alert')).toHaveTextContent('Preserve the key and transaction files');
 await act(async()=>finishSettings(settings));
 expect(screen.getByRole('alert')).toHaveTextContent('Preserve the key and transaction files');
 expect(screen.getByRole('button',{name:'Retry key information'})).toBeEnabled();
});

it('refreshes authoritative scope before consuming a restart reply that precedes runtime events',async()=>{
 runtime.snapshot={needsRestart:true};
 const draft=vi.fn(); mount(draft);
 const cluster=await screen.findByLabelText('Cluster');
 fireEvent.change(cluster,{target:{value:'unsaved-cluster'}});
 mocks.getSettings.mockImplementation(async scope=>{
  if(scope.epoch!==2)throw {code:'PROFILE_CHANGED'};
  return settings;
 });
 runtime.retry.mockImplementation(async()=>{runtime.scope={profileId:'default',epoch:2};runtime.snapshot={needsRestart:false};});
 mocks.restartProxy.mockResolvedValue({consumedDraftRevision:1});
 fireEvent.click(screen.getByRole('button',{name:'Restart and apply'}));
 await waitFor(()=>expect(screen.getByLabelText('Cluster')).toHaveValue('training'));
 expect(screen.getByRole('button',{name:'Save Settings'})).toBeDisabled();
 expect(draft).toHaveBeenLastCalledWith({dirty:false,draftRevision:1});
});

it('preserves a newer edit made while an owned restart refresh is pending',async()=>{
 runtime.snapshot={needsRestart:true};
 let finish;
 runtime.retry.mockImplementation(()=>new Promise(resolve=>{finish=()=>{runtime.scope={profileId:'default',epoch:2};resolve();};}));
 mocks.restartProxy.mockResolvedValue({consumedDraftRevision:1});
 const draft=vi.fn(); mount(draft);
 const cluster=await screen.findByLabelText('Cluster');
 fireEvent.change(cluster,{target:{value:'older-draft'}});
 fireEvent.click(screen.getByRole('button',{name:'Restart and apply'}));
 await waitFor(()=>expect(finish).toBeTypeOf('function'));
 fireEvent.change(cluster,{target:{value:'newer-draft'}});
 await act(async()=>finish());
 expect(screen.getByLabelText('Cluster')).toHaveValue('newer-draft');
 expect(draft).toHaveBeenLastCalledWith({dirty:true,draftRevision:2});
});

it('does not acknowledge draft consumption if authoritative saved settings cannot be read',async()=>{
 runtime.snapshot={needsRestart:true};
 const draft=vi.fn(); mount(draft);
 fireEvent.change(await screen.findByLabelText('Cluster'),{target:{value:'preserved-draft'}});
 runtime.retry.mockImplementation(async()=>{runtime.scope={profileId:'default',epoch:2};});
 mocks.getSettings.mockRejectedValue({code:'SETTINGS_LOAD_FAILED'});
 mocks.restartProxy.mockResolvedValue({consumedDraftRevision:1});
 fireEvent.click(screen.getByRole('button',{name:'Restart and apply'}));
 expect(await screen.findByRole('alert')).toHaveTextContent('Could not load settings');
 expect(draft).toHaveBeenLastCalledWith({dirty:true,draftRevision:1});
 expect(screen.getByRole('button',{name:'Retry'})).toBeEnabled();
});
