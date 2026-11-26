'use client';
import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Check, Download, Loader2, Users, X } from 'lucide-react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { selectedSpeakerModel, saveSpeakerModel, SpeakerModel } from '@/lib/meeting-speakers';

const models = [
  {id: 'local', name: 'Local speaker identification', detail: 'No account required · 34 MB of model weights'},
  {id: 'community-1', name: 'pyannote Community-1', detail: 'Hugging Face authorization · 33 MB of model weights'},
] as const;
interface Status { ready: SpeakerModel[]; active: {model: SpeakerModel; stage: string; percent: number | null} | null }
const repo = 'https://huggingface.co/pyannote/speaker-diarization-community-1';

export function SpeakerModelSettings() {
  const [status,setStatus] = useState<Status>({ready:[],active:null});
  const [selected,select] = useState<SpeakerModel | null>(null);
  const [pending,setPending] = useState<SpeakerModel | null>(null);
  const [auth,setAuth] = useState(false);
  const [token,setToken] = useState('');
  const [error,setError] = useState('');
  const refresh = useCallback(async () => setStatus(await invoke<Status>('speaker_model_status')),[]);
  useEffect(() => { select(selectedSpeakerModel()); refresh().catch(e=>setError(String(e))); },[refresh]);
  const busy = pending ?? status.active?.model;
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => { refresh().catch(e=>setError(String(e))); },600);
    return () => clearInterval(timer);
  },[busy,refresh]);
  function choose(id: SpeakerModel | null) { saveSpeakerModel(id); select(id); }
  async function install(id: SpeakerModel) {
    setPending(id); setError('');
    const credential = id === 'community-1' ? token.trim() : null;
    setToken('');
    try {
      await invoke('download_speaker_model',{model:id, token:credential});
      choose(id); setAuth(false);
    } catch (e) { if (String(e) !== 'Download cancelled') setError(String(e)); }
    finally { setPending(null); await refresh().catch(e=>setError(String(e))); }
  }
  const open = (url:string) => invoke('open_external_url',{url}).catch(e=>setError(String(e)));
  return <section className="space-y-3 border-t pt-5" aria-label="Speaker identification">
    <div className="flex items-center justify-between gap-3"><div>
      <h3 className="text-sm font-medium text-gray-800">Speaker identification</h3>
      <p className="text-sm text-gray-500">Label speakers after recording. Audio stays on this device.</p>
    </div>{selected && <Button variant="ghost" size="sm" disabled={!!busy} onClick={()=>choose(null)}>Turn off</Button>}</div>
    {models.map(({id,name,detail}) => {
      const ready = status.ready.includes(id), active = status.active?.model === id ? status.active : null;
      const working = busy === id;
      return <div key={id} className={`rounded-lg border-2 p-3 ${selected===id?'border-blue-500 bg-blue-50':'border-gray-200'}`}>
        <div className="flex items-center gap-3"><Users size={18} className="text-gray-500"/><div className="flex-1">
          <div className="text-sm font-semibold">{name}</div><div className="text-xs text-gray-500">{detail}</div>
        </div>{working ? <Button size="sm" variant="ghost" aria-label="Cancel speaker model download" onClick={()=>invoke('cancel_speaker_download',{model:id}).catch(e=>setError(String(e)))}><X size={16}/></Button>
          : <Button size="sm" variant="outline" disabled={!!busy || selected===id && ready}
              onClick={()=>{if(ready) choose(id); else if(id==='community-1'){setError('');setAuth(true);} else void install(id);}}>
              {ready ? (selected===id ? <><Check size={15}/> Selected</> : 'Select') : <><Download size={15}/> Download</>}
            </Button>}</div>
        {working && <div className="mt-3 space-y-1" role="status"><div className="flex items-center gap-2 text-xs text-gray-600"><Loader2 className="animate-spin" size={14}/>{active?.stage || 'Preparing download'} {active?.percent!=null && `${active.percent}%`}</div>
          {active?.percent!=null && <progress className="w-full accent-blue-600" max={100} value={active.percent}/>}</div>}
        {id==='community-1' && auth && !working && !ready && <div className="mt-3 space-y-2 border-t pt-3 text-sm">
          <p>Sign in to Hugging Face and <button className="text-blue-700 underline" onClick={()=>open(repo)}>accept the model conditions</button>. Then <button className="text-blue-700 underline" onClick={()=>open('https://huggingface.co/settings/tokens')}>create a read token</button> with access to this model.</p>
          <Label htmlFor="diarization-token">Hugging Face read token</Label>
          <Input id="diarization-token" type="password" autoComplete="off" value={token} onChange={e=>setToken(e.target.value)} />
          <p className="text-xs text-gray-500">Used only for this download. The token is never saved.</p>
          <Button size="sm" disabled={!token.trim() || !!busy} onClick={()=>install(id)}>Download and use</Button>
          <Button size="sm" variant="ghost" onClick={()=>{setToken('');setAuth(false);setError('');}}>Cancel</Button>
        </div>}
      </div>;
    })}
    <p className="text-xs text-gray-500">The first download also installs the local inference runtime.</p>
    {error && <p className="text-sm text-red-700" role="alert">{error}</p>}
  </section>;
}
