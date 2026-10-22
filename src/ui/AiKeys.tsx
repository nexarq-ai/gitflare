import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Button } from '@cloudflare/kumo/components/button';
import { Dialog } from '@cloudflare/kumo/components/dialog';
import { Input } from '@cloudflare/kumo/components/input';
import { TrashIcon, XIcon } from '@phosphor-icons/react';
import type { AiKeyProvider, AiKeysSnapshot } from '../shared/types';
import { request } from './api';

type Send = (path: string, body: unknown, label: string) => Promise<AiKeysSnapshot | null>;

function useAiKeySender(onChanged: (snapshot: AiKeysSnapshot) => void) {
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const send: Send = async (path, body, label) => {
    setBusy(label); setError(''); setNotice('');
    try {
      const result = await request<AiKeysSnapshot>(path, body, crypto.randomUUID());
      onChanged(result);
      setNotice(result.verification ? `Checked with ${result.verification.model}. ${result.verification.detail}` : 'Saved.');
      return result;
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'The change could not be saved.'); return null; }
    finally { setBusy(''); }
  };
  return { busy, error, notice, send, reset: () => { setError(''); setNotice(''); } };
}

function FocusedDialog({ open, title, description, busy, onClose, children }: { open: boolean; title: string; description: string; busy: boolean; onClose: () => void; children: ReactNode }) {
  return <Dialog.Root open={open} onOpenChange={value => { if (!value && !busy) onClose(); }}>
    <Dialog size="lg" className="dialog-content">
      <div className="dialog-title-row"><Dialog.Title className="dialog-title">{title}</Dialog.Title><Button variant="ghost" size="base" shape="square" icon={XIcon} aria-label="Close dialog" disabled={busy} onClick={onClose} /></div>
      <Dialog.Description className="dialog-description">{description}</Dialog.Description>
      {children}
    </Dialog>
  </Dialog.Root>;
}

export function ProviderKeysDialog({ open, snapshot, onClose, onChanged }: { open: boolean; snapshot: AiKeysSnapshot; onClose: () => void; onChanged: (snapshot: AiKeysSnapshot) => void }) {
  const { busy, error, notice, send, reset } = useAiKeySender(onChanged);
  const [provider, setProvider] = useState<AiKeyProvider>(snapshot.providers[0]?.id ?? 'anthropic');
  const [key, setKey] = useState('');
  useEffect(() => { if (open) { reset(); setKey(''); } }, [open]);
  const label = (id: AiKeyProvider) => snapshot.providers.find(entry => entry.id === id)?.label ?? id;
  async function add(event: FormEvent) { event.preventDefault(); if (await send('/api/ai-keys/action', { action: 'add', provider, key: key.trim() }, 'add')) setKey(''); }
  return <FocusedDialog open={open} title="Add a provider key" description="Agents use the key whose provider matches the model, through Gitflare's AI Gateway. The key is checked with one small billed request, stored encrypted and never shown again." busy={!!busy} onClose={onClose}>
    {snapshot.keys.length > 0 && <ul className="models-dialog-list">{snapshot.keys.map(entry => <li key={entry.provider}><div><strong>{label(entry.provider)}</strong><small>••••{entry.last4} · added {new Date(entry.addedAt).toLocaleDateString()}</small></div><Button variant="ghost" size="sm" loading={busy === `test:${entry.provider}`} disabled={!!busy} onClick={() => void send('/api/ai-keys/action', { action: 'test', provider: entry.provider }, `test:${entry.provider}`)}>Check</Button><Button variant="ghost" size="sm" icon={TrashIcon} aria-label={`Remove ${label(entry.provider)} key`} loading={busy === `remove:${entry.provider}`} disabled={!!busy} onClick={() => void send('/api/ai-keys/action', { action: 'remove', provider: entry.provider }, `remove:${entry.provider}`)} /></li>)}</ul>}
    <form onSubmit={event => void add(event)}>
      <div className="form-field"><label htmlFor="ai-key-provider">Provider</label><select id="ai-key-provider" value={provider} disabled={!!busy} onChange={event => setProvider(event.target.value as AiKeyProvider)}>{snapshot.providers.map(entry => <option key={entry.id} value={entry.id}>{entry.label}{snapshot.keys.some(item => item.provider === entry.id) ? ' (replace key)' : ''}</option>)}</select></div>
      <div className="form-field"><label htmlFor="ai-key-value">API key</label><Input id="ai-key-value" aria-label="API key" type="password" autoComplete="off" value={key} required minLength={8} maxLength={512} disabled={!!busy} onChange={event => setKey(event.target.value)} /></div>
      {error && <div className="form-error" role="alert">{error}</div>}
      {notice && <p className="models-notice" role="status">{notice}</p>}
      <div className="dialog-actions"><Button variant="secondary" size="base" type="button" disabled={!!busy} onClick={onClose}>Done</Button><Button variant="primary" size="base" type="submit" loading={busy === 'add'} disabled={!key.trim()}>Check and save</Button></div>
    </form>
  </FocusedDialog>;
}

export function OwnGatewayDialog({ open, snapshot, onClose, onChanged }: { open: boolean; snapshot: AiKeysSnapshot; onClose: () => void; onChanged: (snapshot: AiKeysSnapshot) => void }) {
  const { busy, error, notice, send, reset } = useAiKeySender(onChanged);
  const [accountId, setAccountId] = useState('');
  const [gatewayId, setGatewayId] = useState('');
  const [token, setToken] = useState('');
  useEffect(() => { if (open) { reset(); setToken(''); setAccountId(snapshot.gateway?.accountId ?? ''); setGatewayId(snapshot.gateway?.gatewayId ?? ''); } }, [open]);
  async function save(event: FormEvent) { event.preventDefault(); if (await send('/api/ai-gateway', { action: 'set', accountId: accountId.trim(), gatewayId: gatewayId.trim(), ...(token.trim() ? { token: token.trim() } : {}) }, 'gateway')) setToken(''); }
  return <FocusedDialog open={open} title="Use your own AI Gateway" description="Send this workspace's inference through an AI Gateway in your Cloudflare account, with the provider keys stored there." busy={!!busy} onClose={onClose}>
    {snapshot.gateway && <ul className="models-dialog-list"><li><div><strong>{snapshot.gateway.gatewayId}</strong><small>{snapshot.gateway.accountId} · {snapshot.gateway.authenticated ? `authenticated, token ••••${snapshot.gateway.tokenLast4 ?? ''}` : 'unauthenticated'}</small></div><Button variant="ghost" size="sm" icon={TrashIcon} loading={busy === 'clear'} disabled={!!busy} onClick={() => void send('/api/ai-gateway', { action: 'clear' }, 'clear')}>Stop using</Button></li></ul>}
    <form onSubmit={event => void save(event)}>
      <div className="form-field"><label htmlFor="ai-gateway-account">Cloudflare account ID</label><Input id="ai-gateway-account" aria-label="Cloudflare account ID" value={accountId} required pattern="[a-f0-9]{32}" maxLength={32} disabled={!!busy} onChange={event => setAccountId(event.target.value)} /></div>
      <div className="form-field"><label htmlFor="ai-gateway-id">AI Gateway ID</label><Input id="ai-gateway-id" aria-label="AI Gateway ID" value={gatewayId} required maxLength={64} disabled={!!busy} onChange={event => setGatewayId(event.target.value)} /></div>
      <div className="form-field"><label htmlFor="ai-gateway-token">Gateway token <span className="models-optional">(authenticated gateways only)</span></label><Input id="ai-gateway-token" aria-label="Gateway token" type="password" autoComplete="off" value={token} maxLength={256} disabled={!!busy} onChange={event => setToken(event.target.value)} /></div>
      {error && <div className="form-error" role="alert">{error}</div>}
      {notice && <p className="models-notice" role="status">{notice}</p>}
      <div className="dialog-actions"><Button variant="secondary" size="base" type="button" disabled={!!busy} onClick={onClose}>Done</Button><Button variant="primary" size="base" type="submit" loading={busy === 'gateway'} disabled={!accountId.trim() || !gatewayId.trim()}>{snapshot.gateway ? 'Replace gateway' : 'Save gateway'}</Button></div>
    </form>
  </FocusedDialog>;
}
