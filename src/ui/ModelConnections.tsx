import { useEffect, useState, type FormEvent } from 'react';
import InfoTip from "./InfoTip";
import { Button, LinkButton } from '@cloudflare/kumo/components/button';
import { Dialog } from '@cloudflare/kumo/components/dialog';
import { Input } from '@cloudflare/kumo/components/input';
import { CloudIcon, KeyIcon, PlusIcon, TrashIcon, WarningCircleIcon, XIcon } from '@phosphor-icons/react';
import { returnPathFrom } from '../shared/ai-setup';
import type { AiKeysSnapshot, ModelConnection, ModelConnectionsSnapshot } from '../shared/types';
import { request } from './api';
import { PageLoading } from './WorkspaceLoader';
import { OwnGatewayDialog, ProviderKeysDialog } from './AiKeys';
import DemoFeaturePanel, { demoOf } from './DemoFeaturePanel';
import type { DemoMarked } from '../shared/demo-features';
import { inferenceRoute, modelStatus, STATUS_LABELS } from './models-data';
import './model-connections.css';

type Dialogs = 'keys' | 'gateway' | 'model' | null;

export default function ModelConnections({ canManage }: { canManage: boolean }) {
  const [snapshot, setSnapshot] = useState<(ModelConnectionsSnapshot & DemoMarked) | null>(null);
  const [keys, setKeys] = useState<AiKeysSnapshot | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [dialog, setDialog] = useState<Dialogs>(null);
  const [back] = useState(() => returnPathFrom(window.location.search));

  useEffect(() => {
    let active = true;
    void request<ModelConnectionsSnapshot>('/api/models').then(value => { if (active) setSnapshot(value); }).catch(failure => { if (active) setError(failure instanceof Error ? failure.message : 'Models could not be loaded.'); });
    void request<AiKeysSnapshot>('/api/ai-keys').then(value => { if (active) setKeys(value); }).catch(() => {});
    return () => { active = false; };
  }, []);

  async function action(body: Record<string, unknown>, key: string, done: string) {
    if (!canManage || busy) return false;
    setBusy(key); setError(''); setNotice('');
    try {
      const result = await request<ModelConnectionsSnapshot>('/api/models/action', body);
      setSnapshot(result);
      setNotice(body.action === 'verify' ? result.models.find(model => model.id === body.modelId)?.verification?.detail ?? done : done);
      return true;
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'The change could not be saved.'); return false; }
    finally { setBusy(''); }
  }

  const demo = demoOf(snapshot);
  const route = inferenceRoute(keys);
  const ready = !!snapshot && snapshot.models.some(model => modelStatus(model, keys, snapshot) === 'ready');
  return <>
    <div className="page-heading"><div><h1>AI models</h1><p>The models your agents can use. New missions start with the default.</p></div></div>
    {error && <div className="error-notice" role="alert">{error}</div>}
    {notice && <p className="models-notice" role="status">{notice}</p>}
    {back && snapshot && !demo && <div className="models-return" role="status"><p>{ready ? 'Your AI model is ready.' : 'Add a provider key, then go back to your request.'}</p><LinkButton variant={ready ? 'primary' : 'secondary'} size="base" href={back}>Back to request</LinkButton></div>}
    {!snapshot ? !error && <PageLoading /> : demo ? <DemoFeaturePanel demo={demo} examples={snapshot.examples} /> : <>
      {route && <p className={`models-route models-route-${route.tone}`}>{route.tone === 'warn' ? <WarningCircleIcon size={16} aria-hidden="true" /> : <CloudIcon size={16} aria-hidden="true" />}{route.text}</p>}
      <section className="panel">
        <div className="panel-header"><h2>Models<InfoTip label="model status">Ready: usable now. Needs a key: add the provider's key. Not verified: Verify sends one small billed request.</InfoTip></h2><span className="number-tag">{snapshot.models.length}</span></div>
        {snapshot.models.length ? <fieldset className="models-choices" disabled={!canManage || !!busy}>
          <legend className="sr-only">Default for missions</legend>
          {snapshot.models.map(model => <ModelRow key={model.id} model={model} status={modelStatus(model, keys, snapshot)} isDefault={snapshot.defaultModel === model.id} canManage={canManage} busy={busy}
            onDefault={() => void action({ action: 'default', modelId: model.id }, `default:${model.id}`, `${model.label} is the default for new missions.`)}
            onVerify={() => void action({ action: 'verify', modelId: model.id }, `verify:${model.id}`, 'Check finished.')}
            onRemove={() => void action({ action: 'remove', modelId: model.id }, `remove:${model.id}`, `${model.label} removed.`)} />)}
        </fieldset> : <div className="panel-body"><p className="people-muted">No models are available. {canManage ? 'Add one below.' : 'Ask an Owner to add one.'}</p></div>}
        <div className="panel-body"><p className="people-muted">Each agent keeps the model it started with. {canManage ? 'Choosing a default changes only new missions.' : 'Owners choose the models and the default.'}</p></div>
      </section>
      {canManage && <div className="models-more">
        {keys && <Button variant="secondary" size="base" icon={KeyIcon} onClick={() => setDialog('keys')}>{keys.keys.length ? `Provider keys (${keys.keys.length})` : 'Add a provider key'}</Button>}
        {keys && <Button variant="secondary" size="base" icon={CloudIcon} onClick={() => setDialog('gateway')}>{keys.gateway ? 'Your AI Gateway' : 'Use your own AI Gateway'}</Button>}
        <Button variant="secondary" size="base" icon={PlusIcon} onClick={() => setDialog('model')}>Add another model</Button>
      </div>}
      {keys && <ProviderKeysDialog open={dialog === 'keys'} snapshot={keys} onClose={() => setDialog(null)} onChanged={setKeys} />}
      {keys && <OwnGatewayDialog open={dialog === 'gateway'} snapshot={keys} onClose={() => setDialog(null)} onChanged={setKeys} />}
      <AddModelDialog open={dialog === 'model'} snapshot={snapshot} onClose={() => setDialog(null)} onAdd={async (model, key) => { const ok = await action({ action: 'add', model }, key, `${model.label} added.`); if (ok) setDialog(null); return ok; }} busy={busy} error={error} />
    </>}
  </>;
}

function ModelRow({ model, status, isDefault, canManage, busy, onDefault, onVerify, onRemove }: { model: ModelConnection; status: ReturnType<typeof modelStatus>; isDefault: boolean; canManage: boolean; busy: string; onDefault: () => void; onVerify: () => void; onRemove: () => void }) {
  return <div className="models-choice">
    {canManage ? <input type="radio" name="default-model" id={`default-${model.id}`} checked={isDefault} onChange={onDefault} aria-describedby={`status-${model.id}`} /> : <span className="models-radio-placeholder" aria-hidden="true" />}
    <label htmlFor={`default-${model.id}`} className="models-choice-name"><strong>{model.label}</strong>{isDefault && <span className="people-tag">Default for missions</span>}<small>{model.source === 'workers-ai' ? 'Workers AI' : model.id}</small></label>
    <span id={`status-${model.id}`} className={`models-status models-status-${status}`}>{STATUS_LABELS[status]}</span>
    {canManage && <span className="models-row-actions">
      {(status === 'unverified' || status === 'failed') && <Button variant="ghost" size="sm" loading={busy === `verify:${model.id}`} disabled={!!busy} onClick={onVerify}>Verify</Button>}
      {!isDefault && <Button variant="ghost" size="sm" shape="square" icon={TrashIcon} aria-label={`Remove ${model.label}`} loading={busy === `remove:${model.id}`} disabled={!!busy} onClick={onRemove} />}
    </span>}
  </div>;
}

function AddModelDialog({ open, snapshot, busy, error, onClose, onAdd }: { open: boolean; snapshot: ModelConnectionsSnapshot; busy: string; error: string; onClose: () => void; onAdd: (model: ModelConnection, key: string) => Promise<boolean> }) {
  const [kind, setKind] = useState<'gateway' | 'workers-ai'>('gateway');
  const [label, setLabel] = useState('');
  const [id, setId] = useState('');
  const [protocol, setProtocol] = useState<'responses' | 'chat' | 'anthropic'>('chat');
  useEffect(() => { if (open) { setLabel(''); setId(''); setKind('gateway'); } }, [open]);
  useEffect(() => { if (id.startsWith('anthropic/')) setProtocol('anthropic'); else if (id.startsWith('openai/')) setProtocol('responses'); }, [id]);
  const workers = snapshot.workersAI.enabled ? snapshot.workersAICatalog.filter(model => !snapshot.models.some(entry => entry.id === model.id)) : [];
  async function submit(event: FormEvent) { event.preventDefault(); await onAdd({ id: id.trim(), label: label.trim(), source: 'gateway', protocol }, 'add'); }
  return <Dialog.Root open={open} onOpenChange={value => { if (!value && !busy) onClose(); }}>
    <Dialog size="lg" className="dialog-content">
      <div className="dialog-title-row"><Dialog.Title className="dialog-title">Add another model</Dialog.Title><Button variant="ghost" size="base" shape="square" icon={XIcon} aria-label="Close dialog" disabled={!!busy} onClick={onClose} /></div>
      <Dialog.Description className="dialog-description">Add a model your AI Gateway can reach{workers.length ? ', or a Cloudflare-hosted Workers AI model' : ''}.</Dialog.Description>
      {workers.length > 0 && <div className="models-kind" role="radiogroup" aria-label="Model source">
        <label><input type="radio" name="model-kind" checked={kind === 'gateway'} onChange={() => setKind('gateway')} />Through AI Gateway</label>
        <label><input type="radio" name="model-kind" checked={kind === 'workers-ai'} onChange={() => setKind('workers-ai')} />Workers AI</label>
      </div>}
      {kind === 'workers-ai' ? <ul className="models-dialog-list">{workers.map(model => <li key={model.id}><div><strong>{model.label}</strong><small>{model.id}</small></div><Button variant="secondary" size="sm" loading={busy === `add:${model.id}`} disabled={!!busy} onClick={() => void onAdd(model, `add:${model.id}`)}>Add</Button></li>)}</ul>
        : <form onSubmit={event => void submit(event)}>
          <div className="form-field"><label htmlFor="model-label">Name</label><Input id="model-label" aria-label="Name" value={label} required maxLength={80} placeholder="My coding model" onChange={event => setLabel(event.target.value)} /></div>
          <div className="form-field"><label htmlFor="model-id">Model identifier</label><Input id="model-id" aria-label="Model identifier" value={id} required maxLength={200} placeholder="provider/model" onChange={event => setId(event.target.value)} /><small>As your AI Gateway names it, for example mistral/codestral-latest.</small></div>
          <div className="form-field"><label htmlFor="model-transport">API format</label><select id="model-transport" value={protocol} onChange={event => setProtocol(event.target.value as 'responses' | 'chat' | 'anthropic')}><option value="chat">Chat completions (most providers)</option><option value="responses">OpenAI Responses</option><option value="anthropic">Anthropic Messages</option></select></div>
          {error && <div className="form-error" role="alert">{error}</div>}
          <div className="dialog-actions"><Button variant="secondary" size="base" type="button" disabled={!!busy} onClick={onClose}>Cancel</Button><Button variant="primary" size="base" type="submit" loading={busy === 'add'} disabled={!id.trim() || !label.trim()}>Add model</Button></div>
        </form>}
    </Dialog>
  </Dialog.Root>;
}
