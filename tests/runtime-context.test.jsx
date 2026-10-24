import React from 'react';
import {render,screen,fireEvent,waitFor,act} from '@testing-library/react';
import {beforeEach,it,expect,vi} from 'vitest';
import {RuntimeProvider,useRuntime} from '../src/contexts/RuntimeContext';
const mocks=vi.hoisted(()=>({getRuntimeInfo:vi.fn(),getStatus:vi.fn(),onRuntimeState:vi.fn(),setAppDirty:vi.fn(),getStats:vi.fn(),onStatsUpdate:vi.fn()}));
vi.mock('../src/lib/electron',async (importOriginal)=>({...await importOriginal(),...mocks}));
let emit, emitStats; const unsubscribe=vi.fn(); const unsubscribeStats=vi.fn();
let runtime;
function Consumer(){runtime=useRuntime();const {snapshot,scope,loading,error,retry,reportDraft,flushDraft,getDraftRevision}=runtime;return <><output>{error?'failed':loading?'loading':`${scope?.profileId}:${scope?.epoch}:${snapshot?.revision}`}</output><button onClick={retry}>Retry</button><button onClick={()=>reportDraft({dirty:true,draftRevision:2})}>Edit</button><button onClick={()=>reportDraft({dirty:true,draftRevision:getDraftRevision()+1})}>Next edit</button><button onClick={()=>flushDraft()}>Flush</button></>;}
function mount(){return render(<RuntimeProvider><Consumer/></RuntimeProvider>);}
beforeEach(()=>{vi.resetAllMocks();mocks.onRuntimeState.mockImplementation(cb=>{emit=cb;return unsubscribe;});mocks.onStatsUpdate.mockImplementation(cb=>{emitStats=cb;return unsubscribeStats;});mocks.getStats.mockResolvedValue({profileId:'default',epoch:1,sequence:1,sampledAt:1000,totalBytesSent:0,totalBytesReceived:0,sessions:[]});mocks.setAppDirty.mockResolvedValue({dirty:true,draftRevision:2});mocks.getStatus.mockResolvedValue({profileId:'default',epoch:1,revision:1});mocks.getRuntimeInfo.mockResolvedValue({scope:{profileId:'default',epoch:1},draftRevision:0});});
it('retries loading failures without losing the subscription',async()=>{
 mocks.getStatus.mockRejectedValueOnce({code:'INTERNAL_ERROR'});mount();expect(await screen.findByText('failed')).toBeInTheDocument();
 fireEvent.click(screen.getByText('Retry'));expect(await screen.findByText('default:1:1')).toBeInTheDocument();expect(mocks.onRuntimeState).toHaveBeenCalledTimes(1);
});
it('uses whole snapshots and rejects equal or older revisions',async()=>{
 mount();await screen.findByText('default:1:1');
 act(()=>emit({profileId:'default',epoch:3,revision:5}));expect(screen.getByText('default:3:5')).toBeInTheDocument();
 act(()=>emit({profileId:'old',epoch:2,revision:4}));expect(screen.getByText('default:3:5')).toBeInTheDocument();
});
it('unsubscribes on unmount and ignores a late initial getter',async()=>{
 let resolve;mocks.getStatus.mockImplementation(()=>new Promise(done=>{resolve=done;}));const view=mount();await waitFor(()=>expect(resolve).toBeTypeOf('function'));view.unmount();
 await act(async()=>resolve({profileId:'default',epoch:1,revision:1}));expect(unsubscribe).toHaveBeenCalledTimes(1);
});
it('sends immediate scoped draft acknowledgements and flushes the latest draft',async()=>{
 mount();await screen.findByText('default:1:1');fireEvent.click(screen.getByText('Edit'));
 expect(mocks.setAppDirty).toHaveBeenCalledWith({scope:{profileId:'default',epoch:1},dirty:true,draftRevision:2});
 fireEvent.click(screen.getByText('Flush'));await waitFor(()=>expect(mocks.setAppDirty).toHaveBeenCalledTimes(2));
});
it('consumes the old profile draft without resetting its revision counter when the profile changes',async()=>{
 mount(); await screen.findByText('default:1:1'); fireEvent.click(screen.getByText('Edit'));
 act(()=>emit({profileId:'b',epoch:2,revision:2}));
 expect(mocks.setAppDirty).toHaveBeenLastCalledWith({scope:{profileId:'b',epoch:2},dirty:false,draftRevision:2});
 fireEvent.click(screen.getByText('Next edit'));
 expect(mocks.setAppDirty).toHaveBeenLastCalledWith({scope:{profileId:'b',epoch:2},dirty:true,draftRevision:3});
});
it('preserves dirty state across an epoch-only change so a failed action does not discard edits',async()=>{
 mount(); await screen.findByText('default:1:1'); fireEvent.click(screen.getByText('Edit'));
 act(()=>emit({profileId:'default',epoch:2,revision:2}));
 expect(mocks.setAppDirty).toHaveBeenLastCalledWith({scope:{profileId:'default',epoch:2},dirty:true,draftRevision:2});
});

const sample=(sequence,sampledAt,sent,received,extra={})=>({profileId:'default',epoch:1,sequence,sampledAt,totalBytesSent:sent,totalBytesReceived:received,sessions:[],...extra});
it('owns one stats subscription and calculates actual counter differences over elapsed seconds',async()=>{
 const view=mount();await waitFor(()=>expect(runtime.stats.sequence).toBe(1));
 expect(runtime.rates).toEqual({sent:0,received:0});
 act(()=>emitStats(sample(2,1500,512,1024)));
 expect(runtime.rates).toEqual({sent:1024,received:2048});
 act(()=>emitStats(sample(3,3500,1024,2048)));
 expect(runtime.rates).toEqual({sent:256,received:512});
 expect(mocks.onStatsUpdate).toHaveBeenCalledTimes(1);expect(mocks.getStats).toHaveBeenCalledTimes(1);
 view.unmount();expect(unsubscribeStats).toHaveBeenCalledOnce();
});
it('rejects old sequences and stale scopes without replacing the newest live sessions or rates',async()=>{
 mount();await waitFor(()=>expect(runtime.stats.sequence).toBe(1));
 const current=sample(5,2000,100,200,{sessions:[{id:3,bytesSent:100}]});act(()=>emitStats(current));
 for(const stale of [sample(4,3000,9000,9000),sample(99,4000,9000,9000,{epoch:0}),sample(99,4000,9000,9000,{profileId:'other'})]) act(()=>emitStats(stale));
 expect(runtime.stats).toEqual(current);expect(runtime.rates).toEqual({sent:100,received:200});
});
it('resets both rates for nonpositive intervals and either counter rolling back',async()=>{
 mount();await waitFor(()=>expect(runtime.stats.sequence).toBe(1));
 act(()=>emitStats(sample(2,2000,100,200)));expect(runtime.rates.sent).toBe(100);
 act(()=>emitStats(sample(3,2000,200,300)));expect(runtime.rates).toEqual({sent:0,received:0});
 act(()=>emitStats(sample(4,1500,300,400)));expect(runtime.rates).toEqual({sent:0,received:0});
 act(()=>emitStats(sample(5,3000,299,500)));expect(runtime.rates).toEqual({sent:0,received:0});
 act(()=>emitStats(sample(6,4000,400,499)));expect(runtime.rates).toEqual({sent:0,received:0});
 act(()=>emitStats(sample(7,5000,600,999)));expect(runtime.rates).toEqual({sent:200,received:500});
});
it('keeps at most one point per second and 60 points within the last minute',async()=>{
 mount();await waitFor(()=>expect(runtime.stats.sequence).toBe(1));
 act(()=>{for(let i=2;i<=150;i++)emitStats(sample(i,i*500,i*10,i*20));});
 expect(runtime.ratePoints).toHaveLength(60);
 expect(new Set(runtime.ratePoints.map(point=>point.second)).size).toBe(60);
 expect(runtime.ratePoints.at(-1).second-runtime.ratePoints[0].second).toBe(59);
 act(()=>emitStats(sample(151,180000,2000,4000)));expect(runtime.ratePoints).toHaveLength(1);
});
it('clears rates and samples immediately on epoch change and rejects a late initial getter',async()=>{
 let finish;mocks.getStats.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
 mount();await screen.findByText('default:1:1');
 act(()=>emitStats(sample(2,2000,100,200)));
 act(()=>emitStats(sample(3,3000,200,400)));expect(runtime.rates.sent).toBe(100);
 mocks.getStats.mockImplementationOnce(()=>new Promise(()=>{}));
 act(()=>emit({profileId:'default',epoch:2,revision:2}));
 expect(runtime.stats.sessions).toEqual([]);expect(runtime.ratePoints).toEqual([]);expect(runtime.rates).toEqual({sent:0,received:0});
 await act(async()=>finish(sample(99,99000,999,999)));
 expect(runtime.ratePoints).toEqual([]);
 act(()=>emitStats(sample(1,10000,5000,8000,{epoch:2})));
 expect(runtime.rates).toEqual({sent:0,received:0});expect(runtime.stats.epoch).toBe(2);
});
it('retries stats errors independently and a healthy stream recovers without another request',async()=>{
 mocks.getStats.mockRejectedValueOnce({code:'INTERNAL_ERROR'});mount();await waitFor(()=>expect(runtime.statsError?.code).toBe('INTERNAL_ERROR'));
 expect(runtime.error).toBeNull();await act(async()=>runtime.retryStats());expect(runtime.statsError).toBeNull();
 expect(mocks.onStatsUpdate).toHaveBeenCalledTimes(1);
});
it('flushes the latest draft before running an action and never clears it on cancellation',async()=>{
 mount();await screen.findByText('default:1:1');fireEvent.click(screen.getByText('Edit'));
 const action=vi.fn().mockResolvedValue({cancelled:true});await act(async()=>expect(runtime.runAction(action)).resolves.toEqual({cancelled:true}));
 expect(action).toHaveBeenCalledWith({profileId:'default',epoch:1});
 expect(mocks.setAppDirty.mock.invocationCallOrder.at(-1)).toBeLessThan(action.mock.invocationCallOrder[0]);
 expect(mocks.setAppDirty).toHaveBeenLastCalledWith({scope:{profileId:'default',epoch:1},dirty:true,draftRevision:2});
});
it('does not run an action after its draft acknowledgement changed scope',async()=>{
 mount();await screen.findByText('default:1:1');const action=vi.fn();
 let finish;mocks.setAppDirty.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
 const pending=runtime.runAction(action);await waitFor(()=>expect(finish).toBeTypeOf('function'));
 act(()=>emit({profileId:'b',epoch:2,revision:2}));
 await act(async()=>{finish({});await expect(pending).rejects.toMatchObject({code:'PROFILE_CHANGED'});});
 expect(action).not.toHaveBeenCalled();
});

it('exposes the authoritative latest snapshot synchronously without waiting for a React render',async()=>{
 mount(); await screen.findByText('default:1:1');
 const latest={profileId:'default',epoch:2,revision:2,operation:null,errorCode:'KEY_TRANSACTION_FAILED'};
 act(()=>{
   emit(latest);
   expect(runtime.getSnapshot()).toBe(latest);
   expect(runtime.getScope()).toEqual({profileId:'default',epoch:2});
 });
});
