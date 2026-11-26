'use client';

import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { ArrowDown, ArrowUp, Pencil, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';

const formats = { paragraph: 'Paragraph', list: 'List', string: 'Single line' };
type Section = {
  title: string;
  instruction: string;
  format: keyof typeof formats;
  item_format?: string;
  example_item_format?: string;
};
export type TemplateInfo = { id: string; name: string; description: string };
type Template = Omit<TemplateInfo, 'id'> & { sections: Section[] };
type Details = { template: Template; editable: boolean };
const blank: Template = { name: '', description: '', sections: [{ title: '', instruction: '', format: 'paragraph' }] };

function Preview({ template }: { template: Template }) {
  return <article aria-label="Template preview" className="min-w-0 space-y-4 break-words">
    <header><h3 className="font-semibold">{template.name}</h3>
      <p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">{template.description}</p></header>
    <ol className="divide-y rounded-lg border px-4">
      {template.sections.map((section, index) => <li key={index} className="space-y-2 py-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h4 className="text-sm font-semibold">{section.title || 'Untitled section'}</h4>
          <span className="text-xs text-muted-foreground">{formats[section.format]}</span>
        </div>
        <p className="whitespace-pre-wrap text-sm">{section.instruction}</p>
        {(section.item_format || section.example_item_format) &&
          <pre className="whitespace-pre-wrap break-words rounded bg-muted p-2 text-xs">{section.item_format || section.example_item_format}</pre>}
      </li>)}
    </ol>
  </article>;
}

export function TemplateEditor({ id, onClose, onSaved, onDeleted }: {
  id: string | null; onClose: () => void; onSaved: (template: TemplateInfo) => void; onDeleted: (id: string) => void;
}) {
  const [details, setDetails] = useState<Details>();
  const [draft, setDraft] = useState<Template | undefined>(id ? undefined : blank);
  const [keys, setKeys] = useState<string[]>(() => id ? [] : [crypto.randomUUID()]);
  const [saving, setSaving] = useState(false);
  const [discard, setDiscard] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!id) return;
    let active = true;
    invoke<Details>('api_get_template_details', { templateId: id })
      .then(value => { if (active) setDetails(value); })
      .catch(e => { if (active) setError(String(e)); });
    return () => { active = false; };
  }, [id]);

  function edit() {
    if (!details) return;
    const template = details.template;
    setDraft({ ...template, name: details.editable ? template.name : template.name + ' (copy)' });
    setKeys(template.sections.map(() => crypto.randomUUID()));
  }
  function close() {
    if (saving) return;
    if (confirmDelete) { setConfirmDelete(false); return; }
    if (draft && JSON.stringify(draft) !== JSON.stringify(details?.template ?? blank)) setDiscard(true);
    else onClose();
  }
  function update(index: number, changes: Partial<Section>) {
    if (draft) setDraft({ ...draft, sections: draft.sections.map((s, i) => i === index ? { ...s, ...changes } : s) });
  }
  function move(index: number, to: number) {
    if (!draft) return;
    const sections = [...draft.sections], nextKeys = [...keys];
    sections.splice(to, 0, sections.splice(index, 1)[0]);
    nextKeys.splice(to, 0, nextKeys.splice(index, 1)[0]);
    setKeys(nextKeys);
    setDraft({ ...draft, sections });
  }
  async function save() {
    if (!draft || saving || discard || confirmDelete) return;
    setSaving(true);
    setError('');
    try {
      const result = await invoke<TemplateInfo>('api_save_summary_template', { templateId: id, original: details?.template ?? null, draft });
      onSaved(result);
      onClose();
    } catch (e) { setError(String(e)); }
    finally { setSaving(false); }
  }
  async function remove() {
    if (!id || !details?.editable || !confirmDelete || saving) return;
    setSaving(true);
    setError('');
    try {
      await invoke('api_delete_summary_template', { templateId: id, original: details.template });
      onDeleted(id);
      onClose();
    } catch (e) { setError(String(e)); }
    finally { setSaving(false); }
  }
  return <Dialog open onOpenChange={open => { if (!open) close(); }}>
    <DialogContent aria-describedby={undefined} className={'flex max-h-[90vh] w-[95vw] flex-col ' + (draft ? 'max-w-5xl' : 'max-w-2xl')}>
      <DialogHeader><DialogTitle>{confirmDelete ? 'Delete template?' : !id ? 'New template' : draft ? 'Edit template' : 'Template preview'}</DialogTitle></DialogHeader>
      <div className="min-h-0 overflow-y-auto">
        {id && !details && !error && <p role="status">Loading template…</p>}
        {confirmDelete && <p className="text-sm">Delete “{details?.template.name}” from your templates? Previously generated summaries will be kept.</p>}
        {!confirmDelete && details && !draft && <Preview template={details.template} />}
        {!confirmDelete && draft && <div className="grid gap-6 md:grid-cols-2">
          <form id="summary-template-edit" className="min-w-0 space-y-4" onSubmit={e => { e.preventDefault(); void save(); }}>
            <fieldset disabled={saving} className="min-w-0 space-y-4 text-sm">
              <label className="block">Template name<Input required value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} /></label>
              <label className="block">Description<Textarea required value={draft.description} onChange={e => setDraft({ ...draft, description: e.target.value })} /></label>
              {draft.sections.map((s, index) => <fieldset key={keys[index]} className="min-w-0 space-y-3 rounded-lg border p-3">
                <legend className="px-1 font-medium">Section {index + 1}</legend>
                <div className="flex justify-end gap-1">
                  <Button type="button" variant="ghost" size="icon" aria-label={`Move section ${index + 1} up`} disabled={!index} onClick={() => move(index, index - 1)}><ArrowUp size={16}/></Button>
                  <Button type="button" variant="ghost" size="icon" aria-label={`Move section ${index + 1} down`} disabled={index === draft.sections.length - 1} onClick={() => move(index, index + 1)}><ArrowDown size={16}/></Button>
                  <Button type="button" variant="ghost" size="icon" aria-label={`Remove section ${index + 1}`} disabled={draft.sections.length === 1} onClick={() => {
                    setKeys(keys.filter((_, i) => i !== index));
                    setDraft({ ...draft, sections: draft.sections.filter((_, i) => i !== index) });
                  }}><Trash2 size={16}/></Button>
                </div>
                <label className="block">Section title<Input required value={s.title} onChange={e => update(index, { title: e.target.value })}/></label>
                <label className="block">Writing instructions<Textarea required value={s.instruction} onChange={e => update(index, { instruction: e.target.value })}/></label>
                <label className="block">Output format<select className="block h-9 w-full rounded-md border bg-background px-3" value={s.format} onChange={e => update(index, { format: e.target.value as Section['format'] })}>
                  {Object.entries(formats).map(([key, name]) => <option key={key} value={key}>{name}</option>)}
                </select></label>
                <label className="block">Format example (optional)<Textarea value={s.item_format ?? s.example_item_format ?? ''} onChange={e => update(index, { item_format: e.target.value || undefined, example_item_format: undefined })}/></label>
              </fieldset>)}
              <Button type="button" variant="outline" onClick={() => {
                setKeys([...keys, crypto.randomUUID()]);
                setDraft({ ...draft, sections: [...draft.sections, { title: '', instruction: '', format: 'paragraph' }] });
              }}><Plus size={16}/> Add section</Button>
            </fieldset>
          </form>
          <aside className="min-w-0 rounded-lg bg-muted/30 p-4 md:sticky md:top-0 md:max-h-[60vh] md:self-start md:overflow-auto">
            <h3 className="mb-4 text-sm font-medium text-muted-foreground">Live preview</h3><Preview template={draft}/>
          </aside>
        </div>}
      </div>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {confirmDelete ? <DialogFooter><Button type="button" variant="outline" disabled={saving} onClick={() => setConfirmDelete(false)}>Cancel</Button>
        <Button type="button" variant="destructive" disabled={saving} onClick={remove}>Confirm deletion</Button></DialogFooter>
      : discard ? <DialogFooter className="items-center gap-2"><span className="text-sm">Discard unsaved changes?</span>
        <Button variant="outline" onClick={() => setDiscard(false)}>Keep editing</Button><Button variant="destructive" onClick={onClose}>Discard</Button></DialogFooter>
      : <DialogFooter>
        {details?.editable && <Button type="button" variant="ghost" className="text-destructive sm:mr-auto" disabled={saving} onClick={() => setConfirmDelete(true)}><Trash2 size={15}/> Delete template</Button>}
        <Button type="button" variant="outline" disabled={saving} onClick={close}>{draft ? 'Cancel' : 'Close'}</Button>
        {draft ? <Button key="save" type="submit" form="summary-template-edit" disabled={saving}>{saving ? 'Saving…' : !id ? 'Create template' : details?.editable ? 'Save changes' : 'Save as new template'}</Button>
        : details && <Button key="edit" type="button" onClick={event => { event.preventDefault(); edit(); }}><Pencil size={15}/> Edit template</Button>}</DialogFooter>}
    </DialogContent>
  </Dialog>;
}
