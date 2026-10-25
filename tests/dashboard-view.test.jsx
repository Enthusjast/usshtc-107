import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import DashboardView from '../src/views/DashboardView';
import { RuntimeProvider, useRuntime } from '../src/contexts/RuntimeContext';
import { LocaleProvider } from '../src/i18n/LocaleContext';
import { ToastProvider } from '../src/components/Toast';
import en from '../src/i18n/en';
const mocks = vi.hoisted(() => ({ getRuntimeInfo: vi.fn(), retryRecovery: vi.fn(), getStatus: vi.fn(), onRuntimeState: vi.fn(), setAppDirty: vi.fn(), getStats: vi.fn(), getSshKeyInfo: vi.fn(), onStatsUpdate: vi.fn(), startLogin: vi.fn(), startProxy: vi.fn(), stopProxy: vi.fn(), copyToClipboard: vi.fn(), getSettings: vi.fn(), setAppLocale: vi.fn() }));
vi.mock('../src/lib/electron', async (importOriginal) => ({ ...await importOriginal(), ...mocks }));
const config = { host: '0.0.0.0', port: 3000 };
const snapshot = (revision, extra = {}) => ({ profileId: 'default', epoch: 1, revision, loginStatus: 'success', loginStage: null, cookieValid: true, cookieCount: 1, proxyStatus: 'started', desiredConfig: config, runningConfig: config, needsRestart: false, connectionCount: 1, desiredRunning: true, remoteStatus: 'unknown', operation: null, errorCode: null, storageErrorCode: null, ...extra });
let emit, emitStats;
function mount(afterDashboard=null) { return render(<LocaleProvider><ToastProvider><RuntimeProvider><DashboardView />{afterDashboard}</RuntimeProvider></ToastProvider></LocaleProvider>); }
beforeEach(() => {
  vi.resetAllMocks();
  mocks.getSettings.mockResolvedValue({locale:'en'});
  mocks.getStatus.mockResolvedValue(snapshot(1));
  mocks.getRuntimeInfo.mockResolvedValue({ scope: { profileId: 'default', epoch: 1 }, draftRevision: 0 });
  const runtimeListeners = new Set();
  emit = (snapshot) => runtimeListeners.forEach((callback) => callback(snapshot));
  mocks.onRuntimeState.mockImplementation((cb) => { runtimeListeners.add(cb); return () => runtimeListeners.delete(cb); });
  mocks.onStatsUpdate.mockImplementation((callback) => { emitStats = callback; return vi.fn(); });
  mocks.getStats.mockResolvedValue({profileId:'default',epoch:1,sequence:1,sampledAt:1000,totalBytesSent:0,totalBytesReceived:0,sessions:[],uptimeMs:0,sessionCount:0});
  mocks.getSshKeyInfo.mockResolvedValue({scope:'application',client:{state:'ready',publicKey:'ssh-ed25519 test',fingerprint:'SHA256:client',privateKeyPath:'/tmp/key'},host:{state:'ready',fingerprint:'SHA256:host',privateKeyPath:'/tmp/host'},recoveryRequired:false});
  mocks.setAppDirty.mockResolvedValue({dirty:false,draftRevision:0});
  mocks.stopProxy.mockResolvedValue({cancelled:true});
  mocks.retryRecovery.mockResolvedValue({});
});
describe('Runtime dashboard', () => {
  it('subscribes before loading and ignores reordered snapshots', async () => {
    let resolve;
    mocks.getStatus.mockImplementation(() => new Promise((done) => { resolve = done; }));
    mount();
    await act(async () => { emit(snapshot(3)); resolve(snapshot(2,{proxyStatus:'stopped'})); });
    expect(await screen.findByRole('button',{name:'Stop'})).toBeEnabled();
    expect(mocks.onRuntimeState.mock.invocationCallOrder[0]).toBeLessThan(mocks.getStatus.mock.invocationCallOrder[0]);
  });
  it('keeps running command at 3000 when desired changes to 4000 and back', async () => {
    mount();
    await screen.findByRole('button',{name:'Stop'});
    act(() => emit(snapshot(2,{desiredConfig:{...config,port:4000},needsRestart:true})));
    expect(screen.getByText(/ssh -o/)).toHaveTextContent('-p 3000 user@127.0.0.1');
    act(() => emit(snapshot(3)));
    expect(screen.getByText(/ssh -o/)).toHaveTextContent('-p 3000');
  });
  it('acknowledges drafts before native stop and leaves cancellation to main', async () => {
    const confirm = vi.spyOn(window,'confirm');
    mount();
    fireEvent.click(await screen.findByRole('button',{name:'Stop'}));
    await waitFor(() => expect(mocks.stopProxy).toHaveBeenCalledWith({profileId:'default',epoch:1}));
    expect(mocks.setAppDirty.mock.invocationCallOrder[0]).toBeLessThan(mocks.stopProxy.mock.invocationCallOrder[0]);
    expect(confirm).not.toHaveBeenCalled();
    expect(screen.getByRole('button',{name:'Stop'})).toBeEnabled();
    confirm.mockRestore();
  });
  it('uses bracketed IPv6 loopback for a wildcard listener', async () => {
    mocks.getStatus.mockResolvedValue(snapshot(1,{runningConfig:{host:'::',port:3000}}));
    mount();
    expect(await screen.findByText(/ssh -o/)).toHaveTextContent('user@[::1]');
  });
  it('disables login and proxy start while root settings are locked', async () => {
    mocks.getStatus.mockResolvedValue(snapshot(1,{proxyStatus:'stopped',runningConfig:null,storageErrorCode:'SETTINGS_COMMIT_UNKNOWN'}));
    mount();
    expect(await screen.findByRole('button',{name:'Start'})).toBeDisabled();
    expect(screen.getByRole('button',{name:'Re-login'})).toBeDisabled();
    fireEvent.click(screen.getByRole('button',{name:'Start'}));
    fireEvent.click(screen.getByRole('button',{name:'Re-login'}));
    expect(mocks.startProxy).not.toHaveBeenCalled();
    expect(mocks.startLogin).not.toHaveBeenCalled();
  });
});

it('shows shared live rates, a dual-line accessible trend and exact textual samples',async()=>{
 mount();await screen.findByRole('button',{name:'Stop'});
 await waitFor(()=>expect(mocks.getStats).toHaveBeenCalledTimes(1));
 act(()=>emitStats({profileId:'default',epoch:1,sequence:2,sampledAt:3000,totalBytesSent:2048,totalBytesReceived:4096,sessions:[],uptimeMs:2000,sessionCount:0}));
 expect(screen.getByText('1.0 KB/s',{selector:'dd'})).toBeInTheDocument();
 expect(screen.getByText('2.0 KB/s',{selector:'dd'})).toBeInTheDocument();
 expect(screen.getByRole('img',{name:/Sent \(solid\) and received \(dashed\)/})).toBeInTheDocument();
 fireEvent.click(screen.getByText('Show traffic samples'));
 expect(screen.getByRole('table',{name:'Traffic · last 60 seconds'})).toBeInTheDocument();
 expect(mocks.onStatsUpdate).toHaveBeenCalledTimes(1);expect(mocks.getStats).toHaveBeenCalledTimes(1);
});

it('exposes traffic Retry without replacing healthy runtime controls',async()=>{
 mocks.getStats.mockRejectedValueOnce({code:'INTERNAL_ERROR'});mount();
 expect(await screen.findByRole('button',{name:'Stop'})).toBeEnabled();
 expect(await screen.findByRole('alert')).toHaveTextContent('An internal error occurred');
 fireEvent.click(screen.getByRole('button',{name:'Retry'}));
 await waitFor(()=>expect(screen.queryByRole('alert')).not.toBeInTheDocument());
});

it.each([
 ['unknown','Remote reachability has not been checked.'],
 ['checking','Checking remote shell readiness…'],
 ['reachable','The remote shell is ready.'],
 ['offline','The network or platform is offline. Reconnect, then retry.'],
 ['auth_required','The platform requires authentication.'],
 ['error','The connection check failed. Review settings or retry.'],
])('renders the scoped %s remote status with first-frame and optional command proof explained',async(remoteStatus,message)=>{
 mocks.getStatus.mockResolvedValue(snapshot(1,{remoteStatus})); mount();
 expect(await screen.findByText(message)).toBeInTheDocument();
 expect(screen.getByText(/A readiness check waits for the first valid terminal data/)).toHaveTextContent('With health probes enabled, periodic read-only commands also check execution');
 expect(screen.getByText(/Disconnected SSH clients must reconnect themselves/)).toHaveTextContent('Enable the profile’s tmux option before connecting');
 expect(mocks.retryRecovery).not.toHaveBeenCalled();
 if(remoteStatus==='checking') expect(screen.getByRole('button',{name:'Checking connection…'})).toBeDisabled();
 if(remoteStatus==='auth_required') expect(screen.getByRole('button',{name:'Retry connection'})).toBeDisabled();
});

it.each(['REMOTE_READY_TIMEOUT', 'REMOTE_COMMAND_FAILED'])('shows %s without falsely requesting login or restarting a healthy proxy', async (errorCode) => {
 mocks.getStatus.mockResolvedValue(snapshot(1, { remoteStatus: 'error', errorCode })); mount();
 expect(await screen.findByRole('alert')).toHaveTextContent(en[`error_${errorCode}`]);
 expect(screen.getByRole('button', { name: 'Retry connection' })).toBeEnabled();
 expect(screen.getByRole('button', { name: 'Stop' })).toBeEnabled();
 expect(screen.queryByText(en.recoveryLoginRequired)).not.toBeInTheDocument();
 expect(mocks.retryRecovery).not.toHaveBeenCalled();
 expect(mocks.startProxy).not.toHaveBeenCalled();
 expect(mocks.stopProxy).not.toHaveBeenCalled();
});

it('acknowledges drafts before a scoped manual recovery check without direct proxy restart or extra confirmation',async()=>{
 const confirm=vi.spyOn(window,'confirm');
 mocks.getStatus.mockResolvedValue(snapshot(1,{remoteStatus:'offline'})); mount();
 fireEvent.click(await screen.findByRole('button',{name:'Retry connection'}));
 await waitFor(()=>expect(mocks.retryRecovery).toHaveBeenCalledExactlyOnceWith({profileId:'default',epoch:1}));
 expect(mocks.setAppDirty.mock.invocationCallOrder[0]).toBeLessThan(mocks.retryRecovery.mock.invocationCallOrder[0]);
 expect(mocks.startProxy).not.toHaveBeenCalled(); expect(mocks.stopProxy).not.toHaveBeenCalled(); expect(confirm).not.toHaveBeenCalled();
 expect(screen.getByRole('button',{name:'Stop'})).toBeEnabled();
 confirm.mockRestore();
});

it('keeps Stop available while a recovery check is pending and accepts a cancelled round without error',async()=>{
 let resolve; mocks.retryRecovery.mockImplementation(()=>new Promise(done=>{resolve=done;}));
 mount(); fireEvent.click(await screen.findByRole('button',{name:'Retry connection'}));
 await waitFor(()=>expect(mocks.retryRecovery).toHaveBeenCalled());
 expect(screen.getByRole('button',{name:'Checking connection…'})).toBeDisabled();
 fireEvent.click(screen.getByRole('button',{name:'Stop'}));
 await waitFor(()=>expect(mocks.stopProxy).toHaveBeenCalledExactlyOnceWith({profileId:'default',epoch:1}));
 await act(async()=>resolve({cancelled:true}));
 expect(screen.getByRole('button',{name:'Retry connection'})).toBeEnabled(); expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

it('shows a fixed retry error with pending feedback and retries the same current scope',async()=>{
 mocks.retryRecovery.mockRejectedValueOnce({code:'TLS_FAILED',message:'private certificate text'}).mockResolvedValueOnce({reachable:true});
 mount(); fireEvent.click(await screen.findByRole('button',{name:'Retry connection'}));
 expect(await screen.findByRole('alert')).toHaveTextContent('TLS certificate verification failed');
 expect(screen.queryByText('private certificate text')).not.toBeInTheDocument();
 fireEvent.click(screen.getByRole('button',{name:'Retry connection'}));
 await waitFor(()=>expect(mocks.retryRecovery).toHaveBeenCalledTimes(2));
 await waitFor(()=>expect(screen.queryByRole('alert')).not.toBeInTheDocument());
 expect(screen.getByText('Remote reachability has not been checked.')).toBeInTheDocument();
 expect(mocks.startProxy).not.toHaveBeenCalled();
});

it('discards old-epoch recovery failures and permits the new profile to retry independently',async()=>{
 let reject; mocks.retryRecovery.mockImplementationOnce(()=>new Promise((_,fail)=>{reject=fail;})).mockResolvedValueOnce({reachable:true});
 mount(); fireEvent.click(await screen.findByRole('button',{name:'Retry connection'}));
 await waitFor(()=>expect(mocks.retryRecovery).toHaveBeenCalled());
 mocks.getStats.mockResolvedValue({profileId:'b',epoch:2,sequence:1,sampledAt:2000,totalBytesSent:0,totalBytesReceived:0,sessions:[],uptimeMs:0,sessionCount:0});
 act(()=>emit(snapshot(2,{profileId:'b',epoch:2,remoteStatus:'offline'})));
 await act(async()=>reject({code:'TLS_FAILED'}));
 expect(screen.queryByRole('alert')).not.toBeInTheDocument();
 fireEvent.click(screen.getByRole('button',{name:'Retry connection'}));
 await waitFor(()=>expect(mocks.retryRecovery).toHaveBeenLastCalledWith({profileId:'b',epoch:2}));
});

it('never calls recovery for a scope that changed while its draft acknowledgement was pending',async()=>{
 let resolve;
 mount(); const retry = await screen.findByRole('button',{name:'Retry connection'});
 mocks.setAppDirty.mockImplementationOnce(()=>new Promise(done=>{resolve=done;}));
 fireEvent.click(retry);
 await waitFor(()=>expect(resolve).toBeTypeOf('function'));
 mocks.getStats.mockResolvedValue({profileId:'default',epoch:2,sequence:1,sampledAt:2000,totalBytesSent:0,totalBytesReceived:0,sessions:[],uptimeMs:0,sessionCount:0});
 act(()=>emit(snapshot(2,{epoch:2,remoteStatus:'offline'})));
 await act(async()=>resolve({dirty:false,draftRevision:0}));
 expect(mocks.retryRecovery).not.toHaveBeenCalled(); expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

it('does not ask to start a user-stopped proxy when manually checking connectivity',async()=>{
 let finish; mocks.retryRecovery.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
 mocks.getStatus.mockResolvedValue(snapshot(1,{desiredRunning:false,proxyStatus:'stopped',runningConfig:null,remoteStatus:'offline'}));
 function CheckOnLoadedCommit() {
  const {snapshot}=useRuntime();
  const clicked=React.useRef(false);
  React.useLayoutEffect(()=>{
   if(!snapshot||clicked.current) return;
   clicked.current=true;
   // Exercise an enabled control before the previous scope's passive cleanup runs.
   screen.getByRole('button',{name:'Retry connection'}).click();
  },[snapshot]);
  return null;
 }
 mount(<CheckOnLoadedCommit/>);
 await waitFor(()=>expect(mocks.retryRecovery).toHaveBeenCalledExactlyOnceWith({profileId:'default',epoch:1}));
 expect(screen.getByText('Connection is not requested. A check will not start the proxy.')).toBeInTheDocument();
 expect(screen.getByRole('button',{name:'Checking connection…'})).toBeDisabled();
 expect(mocks.startProxy).not.toHaveBeenCalled(); expect(mocks.startLogin).not.toHaveBeenCalled(); expect(mocks.stopProxy).not.toHaveBeenCalled();
 await act(async()=>finish({reachable:true}));
 expect(screen.getByRole('button',{name:'Retry connection'})).toBeEnabled();
});

it('renders localized recovery instructions and authenticated-action guidance in Chinese',async()=>{
 mocks.getSettings.mockResolvedValue({locale:'zh'});
 mocks.getStatus.mockResolvedValue(snapshot(1,{remoteStatus:'auth_required'})); mount();
 expect(await screen.findByRole('heading',{name:'网络与恢复'})).toBeInTheDocument();
 expect(screen.getByRole('button',{name:'重试连接'})).toBeDisabled();
 expect(screen.getByText(/网络重试无法续期认证/)).toBeInTheDocument();
});

it('shows fixed background recovery failures from the scoped runtime snapshot',async()=>{
 mocks.getStatus.mockResolvedValue(snapshot(1,{remoteStatus:'error',errorCode:'NETWORK_UNAVAILABLE'})); mount();
 expect(await screen.findByRole('region',{name:'Network & recovery'})).toHaveTextContent('The network is unavailable. Reconnect and retry.');
 expect(screen.getByRole('button',{name:'Retry connection'})).toBeEnabled();
 expect(screen.getByRole('button',{name:'Stop'})).toBeEnabled();
});

it('uses only the verified client path from the application key DTO in its SSH command',async()=>{
 mount(); await waitFor(()=>expect(screen.getByText(/ssh -o/)).toHaveTextContent('-i "/tmp/key"'));
 expect(screen.getByText(/ssh -o/)).not.toHaveTextContent('/tmp/host');
 expect(mocks.getSshKeyInfo).toHaveBeenCalledExactlyOnceWith({profileId:'default',epoch:1});
});

it('drops the previous key path and rejects a late key read after a runtime scope change',async()=>{
 let finish; mocks.getSshKeyInfo.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
 mount(); await screen.findByRole('button',{name:'Stop'});
 mocks.getSshKeyInfo.mockResolvedValue({scope:'application',client:{state:'missing',publicKey:null,fingerprint:null,privateKeyPath:'/tmp/unverified'},host:{state:'ready',fingerprint:'SHA256:host',privateKeyPath:'/tmp/host'},recoveryRequired:true});
 act(()=>emit(snapshot(2,{epoch:2})));
 await waitFor(()=>expect(mocks.getSshKeyInfo).toHaveBeenCalledTimes(2));
 await act(async()=>finish({scope:'application',client:{state:'ready',privateKeyPath:'/tmp/stale'},host:{state:'ready'},recoveryRequired:false}));
 expect(screen.getByText(/ssh -o/)).not.toHaveTextContent('/tmp/stale'); expect(screen.getByText(/ssh -o/)).not.toHaveTextContent('/tmp/unverified');
});
