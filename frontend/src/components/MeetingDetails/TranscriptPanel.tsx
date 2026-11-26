"use client";

import { Transcript, TranscriptSegmentData } from '@/types';
import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import { toast } from 'sonner';
import { Button } from '../ui/button';
import { Dialog, DialogContent, DialogTitle, DialogHeader, DialogFooter } from '../ui/dialog';
import { Input } from '../ui/input';
import { selectedSpeakerModel, speakerLookup, SpeakerTimeline } from '@/lib/meeting-speakers';
import { VirtualizedTranscriptView } from '@/components/VirtualizedTranscriptView';
import { TranscriptButtonGroup } from './TranscriptButtonGroup';
import { useEffect, useMemo, useRef, useState } from 'react';

interface TranscriptPanelProps {
  transcripts: Transcript[];
  customPrompt: string;
  onPromptChange: (value: string) => void;
  onCopyTranscript: () => void;
  onOpenMeetingFolder: () => Promise<void>;
  isRecording: boolean;
  disableAutoScroll?: boolean;

  // Optional pagination props (when using virtualization)
  usePagination?: boolean;
  segments?: TranscriptSegmentData[];
  hasMore?: boolean;
  isLoadingMore?: boolean;
  totalCount?: number;
  loadedCount?: number;
  onLoadMore?: () => void;

  // Retranscription props
  meetingId?: string;
  meetingFolderPath?: string | null;
  onRefetchTranscripts?: () => Promise<void>;
}

export function TranscriptPanel({
  transcripts,
  customPrompt,
  onPromptChange,
  onCopyTranscript,
  onOpenMeetingFolder,
  isRecording,
  disableAutoScroll = false,
  usePagination = false,
  segments,
  hasMore,
  isLoadingMore,
  totalCount,
  loadedCount,
  onLoadMore,
  meetingId,
  meetingFolderPath,
  onRefetchTranscripts,
}: TranscriptPanelProps) {
  const [timeline, setTimeline] = useState<SpeakerTimeline | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<number | null>(null);
  const [name, setName] = useState('');
  const [savingName, setSavingName] = useState(false);
  const [playing, setPlaying] = useState(false);
  const player = useRef<HTMLAudioElement>(null);
  const lookup = useMemo(() => speakerLookup(timeline?.turns ?? []), [timeline?.turns]);
  const model = selectedSpeakerModel();
  useEffect(() => {
    let current = true;
    if (meetingId) invoke<SpeakerTimeline | null>('get_meeting_speakers', {meetingId})
      .then(value => { if (current) setTimeline(value); })
      .catch(() => { if (current) toast.error('Could not load speaker labels'); });
    return () => { current = false; };
  }, [meetingId]);
  async function identify() {
    setBusy(true);
    try { setTimeline(await invoke<SpeakerTimeline>('identify_meeting_speakers', {meetingId, model})); }
    catch (e) { toast.error('Speaker identification failed', {description:String(e)}); }
    finally { setBusy(false); }
  }
  async function saveName() {
    if (editing === null || savingName) return;
    setSavingName(true);
    try {
      await invoke('rename_meeting_speaker', {meetingId, speaker:editing, name});
      setTimeline(t => t && ({...t, names:{...t.names, [editing]:name.trim()}}));
      setEditing(null);
    } catch { toast.error('Could not save the speaker name'); }
    finally { setSavingName(false); }
  }
  async function seek(seconds: number) {
    try {
      const path = await invoke<string>('meeting_playback_path', {meetingId});
      const audio = player.current;
      if (!audio) return;
      const url = convertFileSrc(path);
      if (audio.src !== url) audio.src = url;
      audio.currentTime = seconds;
      setPlaying(true);
      await audio.play();
    } catch { toast.error('Could not play this recording'); }
  }
  // Convert transcripts to segments if pagination is not used but we want virtualization
  const convertedSegments = useMemo(() => {
    if (usePagination && segments) {
      return segments;
    }
    // Convert transcripts to segments for virtualization
    return transcripts.map(t => ({
      id: t.id,
      timestamp: t.audio_start_time ?? 0,
      endTime: t.audio_end_time,
      text: t.text,
      confidence: t.confidence,
    }));
  }, [transcripts, usePagination, segments]);

  return (
    <div className="flex h-full min-w-0 w-full bg-white flex-col relative @container">
      {/* Title area */}
      <div className="p-4 border-b border-gray-200">
        <TranscriptButtonGroup
          transcriptCount={usePagination ? (totalCount ?? convertedSegments.length) : (transcripts?.length || 0)}
          onCopyTranscript={onCopyTranscript}
          onOpenMeetingFolder={onOpenMeetingFolder}
          meetingId={meetingId}
          meetingFolderPath={meetingFolderPath}
          onRefetchTranscripts={onRefetchTranscripts}
        />
      </div>

      {/* Transcript content - use virtualized view for better performance */}
      {meetingId && meetingFolderPath && model && !timeline && (
        <Button className="self-start mx-4 my-2" size="sm" variant="outline" disabled={busy || isRecording} onClick={identify}>
          {busy ? 'Identifying speakers…' : 'Identify speakers'}
        </Button>
      )}
      <audio ref={player} controls className={playing ? 'w-full px-4' : 'hidden'} />
      <Dialog open={editing !== null} onOpenChange={open => { if (!open && !savingName) setEditing(null); }}>
        <DialogContent><DialogHeader><DialogTitle>Rename speaker in this meeting</DialogTitle></DialogHeader>
          <form onSubmit={e=>{e.preventDefault(); void saveName();}}>
            <Input aria-label="Speaker name" maxLength={80} value={name} placeholder={`Speaker ${editing}`} onChange={e=>setName(e.target.value)} />
            <DialogFooter className="mt-4"><Button type="submit" disabled={savingName}>Save name</Button></DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <div className="flex-1 overflow-hidden pb-4">
        <VirtualizedTranscriptView
          onSeek={meetingId && meetingFolderPath ? seek : undefined}
          renderSpeaker={timeline ? segment => {
            const id = lookup(segment.timestamp, segment.endTime ?? undefined);
            if (id === undefined) return null;
            const label = timeline.names[id] || `Speaker ${id}`;
            return <button type="button" title="Rename speaker in this meeting" onClick={() => {setName(timeline.names[id] || ''); setEditing(id);}}
              className="max-w-32 shrink-0 truncate rounded bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-800 hover:bg-blue-100">{label}</button>;
          } : undefined}
          segments={convertedSegments}
          isRecording={isRecording}
          isPaused={false}
          isProcessing={false}
          isStopping={false}
          enableStreaming={false}
          showConfidence={true}
          disableAutoScroll={disableAutoScroll}
          hasMore={hasMore}
          isLoadingMore={isLoadingMore}
          totalCount={totalCount}
          loadedCount={loadedCount}
          onLoadMore={onLoadMore}
        />
      </div>

      {/* Custom prompt input at bottom of transcript section */}
      {!isRecording && convertedSegments.length > 0 && (
        <div className="p-1 border-t border-gray-200">
          <textarea
            placeholder="Add context for AI summary. For example people involved, meeting overview, objective etc..."
            className="w-full px-3 py-2 border border-gray-200 rounded-md text-sm focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500 bg-white shadow-sm min-h-[80px] resize-y"
            value={customPrompt}
            onChange={(e) => onPromptChange(e.target.value)}
          />
        </div>
      )}
    </div>
  );
}
