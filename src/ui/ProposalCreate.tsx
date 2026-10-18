import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Button } from '@cloudflare/kumo/components/button';
import { Input } from '@cloudflare/kumo/components/input';
import { ArrowClockwiseIcon, ArrowLeftIcon, CaretDownIcon, CaretRightIcon, CircleIcon, InfoIcon, GitBranchIcon, GitMergeIcon, PaperclipIcon, PencilSimpleIcon, PlayIcon, PlusIcon, RobotIcon, ShieldCheckIcon, SparkleIcon, TrashIcon } from '@phosphor-icons/react';
import type { AgentTask, IssueDetail, Mission, Repository, ModelConnectionsSnapshot, AiKeysSnapshot, ModelConnection } from '../shared/types';
import { request, RequestError } from './api';
import { DEFAULT_MAX_AGENTS, DRAFT_GOAL_MAX, MAX_MISSION_AGENTS, MISSION_PROMPT_MAX, byStrength, defaultAllowedModels, draftGoalProblem, draftIsStale, fillBlank, firstLine, mergeDraftAgents, modelOptionLabel, modelVerificationNote, planToManual, strategyLabel, verifiedModels, type MissionDraftResult, type MissionPlanResult } from '../shared/mission-draft';
import RepositoryImport from './RepositoryImport';
import './proposal-create.css';
import './branches.css';
import { repositoryLabel } from "../shared/repository-names";
import { DEFAULT_MODEL } from '../shared/models';

type Attachment = { name: string; content: string };
const maxFiles = 5, maxFileBytes = 16 * 1024, maxTotalBytes = 48 * 1024;
const bytes = (value: string) => new TextEncoder().encode(value).length;

interface DraftAgent extends AgentTask { id: string; open?: boolean }
interface ProposalBase { branch: string; commitSha: string; commitMessage?: string; author?: string; date?: string; }
const startingAgents = (): DraftAgent[] => [
  { id: crypto.randomUUID(), name: '', role: '', task: '' },
  { id: crypto.randomUUID(), name: '', role: '', task: '' },
];

const WHOLE_MISSION = 'Complete the whole mission described in the outcome and acceptance criteria.';

function defaultAgentName(index: number): string { return `Agent ${index + 1}`; }
function defaultAgentRole(): string { return 'Implementation'; }
function Hint({ id, label, text }: { id: string; label: string; text: string }) {
  const [open, setOpen] = useState(false);
  return <><button type="button" className="proposal-hint-button" aria-label={`About ${label}`} aria-expanded={open} aria-controls={id} onClick={() => setOpen(value => !value)}><InfoIcon size={15} aria-hidden="true" /></button>{open && <span id={id} className="proposal-hint" role="note">{text}</span>}</>;
}

function modelLabel(models: ModelConnection[] | undefined, id: string): string { return models?.find(model => model.id === id)?.label ?? id; }

export default function ProposalCreate({ repositories, repositoryId, canContribute, canManage = false, onImportRepository, onBack, onCreateRepository, onCreated }: { repositories: Repository[]; repositoryId?: string; canContribute: boolean; canManage?: boolean; onImportRepository?: (id: string) => void; onBack: () => void; onCreateRepository: () => void; onCreated: (proposal: Mission) => Promise<void> }) {
  const [entry, setEntry] = useState<'auto' | 'manual'>('auto');
  const [repoId, setRepoId] = useState(repositoryId ?? repositories[0]?.id ?? '');
  const [title, setTitle] = useState('');
  const [prompt, setPrompt] = useState('');
  const [criteria, setCriteria] = useState('');
  const [mode, setMode] = useState<'combine' | 'race'>('combine');
  const [agents, setAgents] = useState<DraftAgent[]>(startingAgents);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [base, setBase] = useState<(ProposalBase & { repositoryId: string }) | null>(null);
  const [baseLoading, setBaseLoading] = useState(false);
  const [baseError, setBaseError] = useState('');
  const [baseRefresh, setBaseRefresh] = useState(0);
  const [baseStale, setBaseStale] = useState(false);
  const [emptyRepository, setEmptyRepository] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [attachError, setAttachError] = useState('');
  const [importing, setImporting] = useState(false);
  const [reading, setReading] = useState(0);
  const [importEligible, setImportEligible] = useState(false);
  const attachRef = useRef<Attachment[]>([]);
  const [revealAgent, setRevealAgent] = useState<string | null>(null);
  useEffect(() => {
    if (!revealAgent) return;
    const card = document.querySelector<HTMLElement>(`[data-agent-id="${revealAgent}"]`);
    if (!card) return;
    const smooth = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    card.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'center' });
    card.querySelector<HTMLElement>('textarea, input')?.focus({ preventScroll: true });
    setRevealAgent(null);
  }, [revealAgent]);
  const fileInput = useRef<HTMLInputElement>(null);
  const planRef = useRef<HTMLElement>(null);
  const readChain = useRef<Promise<void>>(Promise.resolve());
  const [models, setModels] = useState<ModelConnectionsSnapshot | null>(null);
  const [drafting, setDrafting] = useState(false);
  const [draftNote, setDraftNote] = useState('');
  const [modelError, setModelError] = useState('');
  const defaultModel = models?.defaultModel ?? DEFAULT_MODEL;
  const [aiReady, setAiReady] = useState(true);
  const [maxAgents, setMaxAgents] = useState(DEFAULT_MAX_AGENTS);
  const [allowed, setAllowed] = useState<string[] | null>(null);
  const [plan, setPlan] = useState<(MissionPlanResult & { repositoryId: string; goal: string }) | null>(null);
  const mutation = useRef<{ signature: string; key: string } | null>(null);
  const latestDraftInput = useRef({ repositoryId: repoId, goal: prompt });
  latestDraftInput.current = { repositoryId: repoId, goal: prompt };
  const draftProblem = prompt.trim() ? draftGoalProblem(prompt) : null;
  const [issue, setIssue] = useState<{ repositoryId: string; number: number; title: string } | null>(null);
  const [issueError, setIssueError] = useState('');
  const names = agents.map(agent => agent.name.trim().toLowerCase());
  const duplicateNames = names.filter((name, index) => name && names.indexOf(name) !== index);
  const repository = repositories.find(item => item.id === repoId);
  const loadedBase = base?.repositoryId === repoId ? base : null;
  const linkedIssue = issue?.repositoryId === repoId ? issue : null;
  const verified = models ? byStrength(verifiedModels(models.models)) : [];
  const allowedModels = allowed ?? (models ? defaultAllowedModels(models.models) : []);
  const currentPlan = plan && !draftIsStale(plan, { repositoryId: repoId, goal: prompt }) ? plan : null;
  const baseReady = !!repository && !!loadedBase && !baseLoading && !baseStale;
  const canCoordinate = mode === 'combine' && agents.length > 1;

  useEffect(() => {
    const requested = new URLSearchParams(window.location.search).get('issue');
    if (!repositoryId || !requested || !/^\d{1,4}$/.test(requested)) return;
    let active = true;
    void request<IssueDetail>(`/api/repositories/${encodeURIComponent(repositoryId)}/issues/${requested}`).then(detail => {
      if (!active) return;
      setIssue({ repositoryId, number: detail.number, title: detail.title });
      setTitle(current => current || detail.title.slice(0, 120));
      setPrompt(current => current || `${detail.title}\n\n${detail.body}`.trim().slice(0, 8000));
    }).catch(failure => { if (active) setIssueError(failure instanceof Error ? failure.message : 'The issue could not be loaded.'); });
    return () => { active = false; };
  }, [repositoryId]);

  useEffect(() => {
    let active = true;
    setModels(null); setModelError('');
    void request<ModelConnectionsSnapshot>('/api/models').then(result => { if (active) setModels(result); }).catch(failure => { if (active) setModelError(failure instanceof Error ? failure.message : 'Models could not be loaded.'); });
    void request<AiKeysSnapshot>('/api/ai-keys').then(result => { if (active) setAiReady(result.ready); }).catch(() => {});
    return () => { active = false; };
  }, []);

  useEffect(() => {
    let active = true;
    setBase(null); setBaseError(''); setEmptyRepository(false);
    if (!repoId) { setBaseLoading(false); return; }
    setBaseLoading(true);
    void request<ProposalBase>(`/api/repositories/${repoId}/proposal-base`).then(result => {
      if (!active) return;
      if (!/^[a-f0-9]{40}$/.test(result.commitSha)) throw new Error('The repository returned an invalid base revision. Refresh to try again.');
      setBase({ ...result, repositoryId: repoId }); setBaseStale(false);
    }).catch(failure => { if (active) { setEmptyRepository(failure instanceof RequestError && failure.code === 'EMPTY_REPOSITORY'); setBaseError(failure instanceof Error ? failure.message : 'The current repository revision could not be loaded.'); } }).finally(() => { if (active) setBaseLoading(false); });
    return () => { active = false; };
  }, [repoId, baseRefresh]);

  useEffect(() => {
    let active = true;
    setImportEligible(false);
    if (!repoId || !canManage) return;
    void request<{ allowed: boolean }>(`/api/repositories/${encodeURIComponent(repoId)}/import`).then(result => { if (active) setImportEligible(!!result.allowed); }).catch(() => { if (active) setImportEligible(false); });
    return () => { active = false; };
  }, [repoId, canManage, baseRefresh]);

  function addFiles(files: FileList | null) {
    if (!files?.length) return;
    const list = Array.from(files);
    setReading(value => value + 1);
    readChain.current = readChain.current.then(() => readFiles(list)).finally(() => setReading(value => value - 1));
  }
  async function readFiles(files: File[]) {
    const next = [...attachRef.current]; const problems: string[] = [];
    for (const file of files) {
      if (next.length >= maxFiles) { problems.push(`Only ${maxFiles} files can be attached.`); break; }
      if (next.some(item => item.name === file.name)) { problems.push(`${file.name} is already attached.`); continue; }
      if (file.size > maxFileBytes) { problems.push(`${file.name} is larger than 16 KiB.`); continue; }
      try {
        const content = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
        if (content.includes('\u0000')) throw new Error('binary');
        if (bytes(content) > maxFileBytes) { problems.push(`${file.name} is larger than 16 KiB.`); continue; }
        if (next.reduce((sum, item) => sum + bytes(item.content), 0) + bytes(content) > maxTotalBytes) { problems.push(`${file.name} would exceed the 48 KiB total.`); continue; }
        next.push({ name: file.name, content });
      } catch { problems.push(`${file.name} is not UTF-8 text or code.`); }
    }
    attachRef.current = next; setAttachments(next); setAttachError(problems.join(' '));
  }
  async function draftWithAi() {
    if (drafting || busy || !repoId || draftGoalProblem(prompt)) return;
    setDrafting(true); setError(''); setDraftNote('');
    const requested = { repositoryId: repoId, goal: prompt };
    const requestedIds = agents.map(agent => agent.id);
    try {
      const draft = await request<MissionDraftResult>('/api/missions/draft', { repositoryId: repoId, goal: prompt.trim(), mode, agents: agents.length, title: title.trim() || undefined, model: agents[0]?.model }, crypto.randomUUID());
      if (draftIsStale(requested, latestDraftInput.current)) { setDraftNote('The repository or goal changed while drafting, so that draft was discarded. Draft again to use the current goal.'); return; }
      setTitle(current => fillBlank(current, draft.title));
      setCriteria(current => fillBlank(current, draft.acceptanceCriteria.join('\n')));
      setAgents(current => mergeDraftAgents(current, draft.tasks, requestedIds));
      setDraftNote(['Draft filled in the blank fields. Review and edit it before creating the mission.', ...(draft.warnings ?? [])].join(' '));
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'The draft could not be created. Fill the fields yourself or try again.'); }
    finally { setDrafting(false); }
  }
  async function planMission() {
    if (drafting || busy || !repoId || draftGoalProblem(prompt) || !allowedModels.length) return;
    setDrafting(true); setError(''); setPlan(null);
    const requested = { repositoryId: repoId, goal: prompt };
    try {
      const result = await request<MissionPlanResult>('/api/missions/draft', { repositoryId: repoId, goal: prompt.trim(), mode: 'auto', maxAgents, allowedModels }, crypto.randomUUID());
      if (draftIsStale(requested, latestDraftInput.current)) { setError('The repository or goal changed while planning, so that plan was discarded. Plan again.'); return; }
      setPlan({ ...result, ...requested });
      requestAnimationFrame(() => { planRef.current?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' }); planRef.current?.focus({ preventScroll: true }); });
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'The mission could not be planned. Try again, or plan it manually.'); }
    finally { setDrafting(false); }
  }
  function editPlan() {
    if (!currentPlan) return;
    const manual = planToManual(currentPlan);
    setMode(manual.mode); setTitle(manual.title); setCriteria(manual.criteria);
    setAgents(manual.tasks.map(task => ({ ...task, id: crypto.randomUUID(), open: false })));
    setDraftNote(''); setError(''); setEntry('manual');
  }

  function updateAgent(id: string, patch: Partial<DraftAgent>) { setAgents(current => current.map(agent => agent.id === id ? { ...agent, ...patch } : agent)); }
  function setCoordinator(id: string, value: boolean) { setAgents(current => current.map(agent => ({ ...agent, coordinator: agent.id === id ? value : value ? false : agent.coordinator }))); }
  function addAgent() {
    if (agents.length >= MAX_MISSION_AGENTS) return;
    const id = crypto.randomUUID();
    setAgents(current => [...current, { id, name: '', role: '', task: '', open: true }]);
    setRevealAgent(id);
  }
  async function save(body: Record<string, unknown>, start: boolean) {
    const signature = JSON.stringify(body);
    if (mutation.current?.signature !== signature) mutation.current = { signature, key: crypto.randomUUID() };
    setBusy(true); setError('');
    try {
      const created = await request<Mission>('/api/missions', body, mutation.current.key);
      let result = created;
      if (start) { try { result = await request<Mission>(`/api/missions/${encodeURIComponent(created.id)}/start`, {}, crypto.randomUUID()); } catch { result = created; } }
      mutation.current = null;
      await onCreated(result);
    } catch (failure) { if (failure instanceof RequestError && failure.code === 'STALE_PROPOSAL_BASE') setBaseStale(true); setError(failure instanceof Error ? failure.message : "The mission could not be created. Your draft is preserved."); }
    finally { setBusy(false); }
  }
  function ready(): boolean {
    if (!loadedBase || baseLoading || baseStale) { setError("Load and review the current repository base before creating the mission."); return false; }
    if (!repository) { setError('Choose an available repository.'); return false; }
    return true;
  }
  async function startPlan() {
    if (busy || reading > 0 || !canContribute || !currentPlan || !ready()) return;
    const tasks = planToManual(currentPlan).tasks;
    if (!models || tasks.some(task => !models.models.some(model => model.id === task.model))) { setError('A planned model is no longer enabled. Plan again.'); return; }
    await save({ mode: currentPlan.mode, repositoryId: repoId, expectedBaseSha: loadedBase!.commitSha, title: currentPlan.title.slice(0, 120), prompt: prompt.trim(), acceptanceCriteria: currentPlan.acceptanceCriteria.length ? currentPlan.acceptanceCriteria : undefined, attachments: attachments.length ? attachments : undefined, tasks, ...(linkedIssue ? { issueNumber: linkedIssue.number } : {}) }, true);
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (entry === 'auto') { if (currentPlan) await startPlan(); else await planMission(); return; }
    if (busy || reading > 0 || !canContribute) return;
    const acceptanceCriteria = criteria.split('\n').map(line => line.trim()).filter(Boolean);
    if (!ready()) return;
    if (!models || agents.some(agent => !models.models.some(model => model.id === (agent.model ?? defaultModel)))) { setError('Choose an enabled model for every agent. A workspace owner can manage AI models in Settings.'); return; }
    if (mode === 'race' && agents.length < 2) { setError('Race mode needs at least two independent candidates.'); return; }
    if (duplicateNames.length) { setError('Give each agent a distinct name.'); return; }
    if (acceptanceCriteria.length > 12 || acceptanceCriteria.some(line => line.length > 500)) { setError('Use up to 12 acceptance criteria, with at most 500 characters per line.'); return; }
    const unassigned = agents.filter(agent => (agents.length > 1 || agent.task.trim()) && agent.task.trim().length < 10);
    if (unassigned.length) setAgents(current => current.map(agent => unassigned.some(item => item.id === agent.id) ? { ...agent, open: true } : agent));
    if (prompt.trim().length < 10 || unassigned.length) { setError("Describe what should change. With several agents, give each one an assignment. Outcomes and assignments need at least 10 characters."); return; }
    await save({ mode, repositoryId: repoId, expectedBaseSha: loadedBase!.commitSha, title: title.trim() || prompt.trim().split('\n')[0].slice(0, 80), prompt: prompt.trim(), acceptanceCriteria: acceptanceCriteria.length ? acceptanceCriteria : undefined, attachments: attachments.length ? attachments : undefined, tasks: agents.map(({ name, role, task, model, coordinator }, index) => ({ name: name.trim() || defaultAgentName(index), role: role.trim() || defaultAgentRole(), task: task.trim() || WHOLE_MISSION, model: model ?? defaultModel, ...(coordinator && canCoordinate ? { coordinator: true } : {}) })), ...(linkedIssue ? { issueNumber: linkedIssue.number } : {}) }, false);
  }

  const repositoryField = <div className="form-field"><label htmlFor="proposal-repository">Repository</label><select id="proposal-repository" required disabled={busy} value={repoId} onChange={event => { setRepoId(event.target.value); setBaseStale(false); }}><option value="" disabled>Choose a repository</option>{repositories.map(repo => <option key={repo.id} value={repo.id}>{repositoryLabel(repo)}{repo.provider === 'local' ? ' (local)' : ''}</option>)}</select></div>;
  const issueLink = <>{linkedIssue && <p className="proposal-issue-link"><CircleIcon size={14} weight="bold" aria-hidden="true" /><span>Fixes <a href={`/repository/${linkedIssue.repositoryId}/issues/${linkedIssue.number}`}>#{linkedIssue.number}</a> {linkedIssue.title}</span><small>The issue closes as completed when this mission lands.</small><Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => setIssue(null)}>Unlink</Button></p>}{issueError && <p className="proposal-name-error" role="alert">{issueError}</p>}</>;
  const contextFiles = <section className="panel proposal-section proposal-attachments"><div className="panel-header"><h2>Context files <span className="proposal-optional">(optional)</span></h2></div><div className="panel-body"><p>Up to 5 text or code files (16 KiB each, 48 KiB total). Agents read them; they are not committed.</p><input ref={fileInput} className="proposal-file-input" type="file" multiple disabled={busy} aria-label="Attach context files" tabIndex={-1} onChange={event => { void addFiles(event.target.files); event.target.value = ''; }} /><div className="proposal-file-picker"><Button type="button" variant="secondary" size="base" icon={PaperclipIcon} disabled={busy || attachments.length >= 5} onClick={() => fileInput.current?.click()}>Choose files</Button><span>{attachments.length ? `${attachments.length} of 5 attached` : 'No files attached'}</span></div>{reading > 0 && <p role="status">Reading files…</p>}{attachError && <p className="proposal-name-error" role="alert">{attachError}</p>}{attachments.length > 0 && <ul className="proposal-attachment-list">{attachments.map(item => <li key={item.name}><code>{item.name}</code><small>{bytes(item.content)} bytes</small><Button type="button" variant="ghost" size="base" disabled={busy} aria-label={`Remove ${item.name}`} onClick={() => { attachRef.current = attachRef.current.filter(entry => entry.name !== item.name); setAttachments(attachRef.current); }}>Remove</Button></li>)}</ul>}</div></section>;

  const autoForm = <>
    <section className="panel proposal-section"><div className="panel-body">
      {issueLink}
      {repositoryField}
      <div className="form-field proposal-goal"><label htmlFor="proposal-goal">What do you want to achieve?</label><textarea id="proposal-goal" required minLength={10} maxLength={DRAFT_GOAL_MAX} disabled={busy || drafting} rows={9} value={prompt} placeholder="Describe the outcome, the context that matters and any constraints." aria-describedby="proposal-goal-count" onChange={event => setPrompt(event.target.value)} /><small id="proposal-goal-count" className="proposal-goal-count">{prompt.length.toLocaleString('en-US')} / {DRAFT_GOAL_MAX.toLocaleString('en-US')}</small></div>
      <div className="proposal-auto-controls">
        <div className="form-field proposal-max-agents"><div className="proposal-control-label"><label htmlFor="proposal-max-agents">Max agents</label><Hint id="proposal-max-agents-hint" label="Max agents" text="Gitflare splits the goal into at most this many agents, one of which coordinates and merges." /></div><select id="proposal-max-agents" disabled={busy || drafting} value={maxAgents} onChange={event => setMaxAgents(Number(event.target.value))}>{Array.from({ length: MAX_MISSION_AGENTS }, (_, index) => index + 1).map(count => <option key={count} value={count}>{count}</option>)}</select><small>Includes the coordinator.</small></div>
        <fieldset className="proposal-allowed-models"><legend className="proposal-control-label"><span>Models allowed</span><Hint id="proposal-models-hint" label="Models allowed" text="Gitflare picks the best of these models per task; stronger models get the building work." /></legend>{!models ? <p className="proposal-muted">Loading models…</p> : !verified.length ? <p className="proposal-muted">No verified models. <a href="/settings/models">Verify a model</a> first.</p> : <div className="proposal-model-chips">{verified.map(model => { const checked = allowedModels.includes(model.id); return <label key={model.id} className={checked ? 'selected' : ''}><input type="checkbox" checked={checked} disabled={busy || drafting} onChange={() => setAllowed(checked ? allowedModels.filter(id => id !== model.id) : [...allowedModels, model.id])} /><span>{model.label}{model.id === defaultModel ? <em>default</em> : null}</span></label>; })}</div>}{models && verified.length > 0 && !allowedModels.length && <small className="proposal-name-error">Choose at least one model.</small>}</fieldset>
      </div>
    </div></section>
    {currentPlan && <section className="panel proposal-section proposal-plan" ref={planRef} tabIndex={-1} aria-labelledby="proposal-plan-title"><div className="panel-header proposal-plan-header"><div><h2 id="proposal-plan-title">{currentPlan.title}</h2><p><strong>{strategyLabel(currentPlan.strategy)}</strong>{currentPlan.strategyReason ? ` · ${currentPlan.strategyReason}` : ''}</p></div><Button type="button" variant="secondary" size="base" icon={PencilSimpleIcon} disabled={busy} onClick={editPlan}>Edit plan</Button></div><div className="panel-body">
      <ol className="proposal-plan-tasks">{currentPlan.tasks.map(task => <li key={task.name} className={task.coordinator ? 'coordinator' : undefined}><div className="proposal-plan-task-head"><span className="proposal-plan-name">{task.coordinator ? <GitMergeIcon size={16} aria-hidden="true" /> : <RobotIcon size={16} aria-hidden="true" />}<strong>{task.name}</strong>{task.coordinator ? <span className="proposal-badge">Coordinator</span> : <span className="proposal-plan-role">{task.role}</span>}</span><span className="proposal-model-badge">{modelLabel(models?.models, task.model)}</span></div><p className="proposal-plan-task">{task.coordinator ? 'Runs after the others pass. Merges their work, resolves conflicts, runs the full test suite and prepares the candidate for review.' : task.task}</p><p className="proposal-plan-reason">{task.reason}</p></li>)}</ol>
      {currentPlan.acceptanceCriteria.length > 0 && <div className="proposal-plan-criteria"><h3>Acceptance criteria</h3><ul>{currentPlan.acceptanceCriteria.map(item => <li key={item}>{item}</li>)}</ul></div>}
      {currentPlan.followUp && <p className="proposal-draft-note"><strong>Next mission:</strong> {currentPlan.followUp}</p>}
      {currentPlan.warnings?.length ? <ul className="proposal-plan-warnings" role="status">{currentPlan.warnings.map(item => <li key={item}>{item}</li>)}</ul> : null}
    </div></section>}
    {contextFiles}
  </>;

  const manualForm = <>
    <section className="panel proposal-section"><div className="panel-header"><h2>Mission details</h2></div><div className="panel-body">{issueLink}{repositoryField}<div className="form-field"><label htmlFor="proposal-title">Mission title <span className="proposal-optional">(optional)</span></label><Input id="proposal-title" maxLength={120} disabled={busy} value={title} placeholder="Make checkout resilient to retries" onChange={event => setTitle(event.target.value)} /></div><div className="form-field"><label htmlFor="proposal-outcome">What should change?</label><textarea id="proposal-outcome" required minLength={10} maxLength={MISSION_PROMPT_MAX} disabled={busy} rows={5} value={prompt} placeholder="Describe the outcome, relevant context, and constraints…" onChange={event => setPrompt(event.target.value)} /><div className="proposal-draft"><Button type="button" variant="secondary" size="base" icon={SparkleIcon} loading={drafting} disabled={busy || drafting || !repoId || !!draftGoalProblem(prompt)} aria-describedby={draftProblem ? 'proposal-draft-limit' : undefined} onClick={() => void draftWithAi()}>Fill blanks with AI</Button><small>Fills only empty fields from your goal and this repository. Nothing is saved until you create the mission.</small></div>{draftProblem && prompt.trim().length > DRAFT_GOAL_MAX && <p id="proposal-draft-limit" className="proposal-name-error" role="status">{draftProblem}</p>}{draftNote && <p className="proposal-draft-note" role="status">{draftNote}</p>}</div><div className="form-field"><label htmlFor="proposal-criteria">Acceptance criteria <span className="proposal-optional">(optional)</span></label><textarea id="proposal-criteria" rows={3} maxLength={6011} disabled={busy} value={criteria} placeholder="One criterion per line…" aria-describedby="proposal-criteria-hint" onChange={event => setCriteria(event.target.value)} /><small id="proposal-criteria-hint">Up to 12 criteria, 500 characters each.</small></div></div></section>
    {contextFiles}
    <section className="panel proposal-section"><div className="panel-header"><h2 id="proposal-mode-title">How agents work</h2></div><div className="panel-body"><div className="mission-mode" role="radiogroup" aria-labelledby="proposal-mode-title"><label className={mode === "combine" ? "selected" : ""}><input type="radio" name="mission-mode" checked={mode === "combine"} disabled={busy} onChange={() => setMode("combine")} /><span><strong>Combine</strong>Each agent builds a part. Gitflare merges and tests them together.</span></label><label className={mode === "race" ? "selected" : ""}><input type="radio" name="mission-mode" checked={mode === "race"} disabled={busy} onChange={() => setMode("race")} /><span><strong>Race</strong>Each agent attempts the whole mission. You keep the best passing one.</span></label></div></div></section>
    <section className="proposal-agents" aria-labelledby="proposal-agents-title"><div className="proposal-agents-heading"><div><h2 id="proposal-agents-title">Agents <span>{agents.length} / {MAX_MISSION_AGENTS}</span></h2><p>{mode === "race" ? "Give each agent a different approach to the whole outcome." : "Give each agent a separate part. One can be the coordinator."}</p></div><Button type="button" variant="secondary" size="base" icon={PlusIcon} disabled={busy || agents.length >= MAX_MISSION_AGENTS} onClick={addAgent}>Add agent</Button></div>{duplicateNames.length > 0 && <p className="proposal-name-error" role="alert">Agent names must be unique.</p>}<div className="proposal-agent-list">{agents.map((agent, index) => {
      const modelId = agent.model ?? defaultModel;
      const selected = models?.models.find(model => model.id === modelId);
      const coordinator = !!agent.coordinator && canCoordinate;
      const summary = firstLine(agent.task) || (agents.length === 1 ? 'Works on the whole mission' : 'No assignment yet');
      return <section className={`panel proposal-agent-card${agent.open ? ' open' : ''}`} key={agent.id} data-agent-id={agent.id} aria-label={`Agent ${index + 1} assignment`}>
        <div className="proposal-agent-heading"><button type="button" className="proposal-agent-toggle" aria-expanded={!!agent.open} aria-controls={`agent-fields-${agent.id}`} onClick={() => updateAgent(agent.id, { open: !agent.open })}>{agent.open ? <CaretDownIcon size={14} aria-hidden="true" /> : <CaretRightIcon size={14} aria-hidden="true" />}{coordinator ? <GitMergeIcon size={18} aria-hidden="true" /> : <RobotIcon size={18} aria-hidden="true" />}<span className="proposal-agent-title"><strong>{agent.name.trim() || defaultAgentName(index)}</strong>{coordinator && <span className="proposal-badge">Coordinator</span>}<span className="proposal-model-badge">{modelLabel(models?.models, modelId)}</span></span>{!agent.open && <span className="proposal-agent-summary">{summary}</span>}</button><Button type="button" variant="ghost" size="base" icon={TrashIcon} disabled={busy || agents.length <= (mode === "race" ? 2 : 1)} aria-label={`Remove ${agent.name || `agent ${index + 1}`}`} onClick={() => setAgents(current => current.filter(item => item.id !== agent.id))} /></div>
        {agent.open && <div className="proposal-agent-fields" id={`agent-fields-${agent.id}`}>
          <div className="proposal-agent-row"><div className="form-field"><label htmlFor={`agent-name-${agent.id}`}>Name <span className="proposal-optional">(optional)</span></label><Input id={`agent-name-${agent.id}`} maxLength={60} placeholder={defaultAgentName(index)} disabled={busy} value={agent.name} aria-invalid={!!agent.name.trim() && names.filter(name => name === agent.name.trim().toLowerCase()).length > 1} onChange={event => updateAgent(agent.id, { name: event.target.value })} /></div><div className="form-field"><label htmlFor={`agent-role-${agent.id}`}>Role <span className="proposal-optional">(optional)</span></label><Input id={`agent-role-${agent.id}`} maxLength={80} disabled={busy} value={agent.role} placeholder={defaultAgentRole()} onChange={event => updateAgent(agent.id, { role: event.target.value })} /></div></div>
          <div className="form-field"><label htmlFor={`agent-model-${agent.id}`}>AI model</label><select id={`agent-model-${agent.id}`} aria-describedby={`agent-model-status-${agent.id}`} required disabled={busy || !models} value={modelId} onChange={event => updateAgent(agent.id, { model: event.target.value })}>{!models ? <option value={DEFAULT_MODEL}>Loading models…</option> : <>{!selected && <option value={modelId} disabled>Selected model is unavailable</option>}{models.models.map(model => <option key={model.id} value={model.id}>{modelOptionLabel(model)}</option>)}</>}</select>{selected && <small className={selected.verification?.status === 'failed' ? 'proposal-name-error' : undefined} id={`agent-model-status-${agent.id}`}>{modelVerificationNote(selected)}</small>}</div>
          {canCoordinate && <label className="proposal-coordinator-toggle"><input type="checkbox" checked={coordinator} disabled={busy} onChange={event => setCoordinator(agent.id, event.target.checked)} /><span><strong>Coordinator</strong>Runs after the others pass, merges their work, resolves conflicts and runs the full test suite.</span></label>}
          {agents.length === 1 ? <details className="form-field proposal-optional-assignment" open={!!agent.task.trim()}><summary>Specific instructions <span className="proposal-optional">(optional, this agent works on the whole mission)</span></summary><textarea id={`agent-task-${agent.id}`} maxLength={2500} disabled={busy} rows={4} value={agent.task} placeholder="Leave blank to give it the whole mission, or add specifics such as files to change…" onChange={event => updateAgent(agent.id, { task: event.target.value })} /></details> : <div className="form-field"><label htmlFor={`agent-task-${agent.id}`}>Assignment</label><textarea id={`agent-task-${agent.id}`} required minLength={10} maxLength={2500} disabled={busy} rows={4} value={agent.task} placeholder={coordinator ? 'Integrate the other parts and make the full test suite pass…' : index === 0 ? 'Implement the core change. Name the files this agent owns…' : 'Describe a separate part and how it fits with the others…'} onChange={event => updateAgent(agent.id, { task: event.target.value })} /></div>}
        </div>}
      </section>;
    })}</div></section>
  </>;

  const autoAction = currentPlan
    ? <><Button type="button" variant="secondary" size="base" icon={PencilSimpleIcon} disabled={busy} onClick={editPlan}>Edit plan</Button><Button type="submit" variant="primary" size="base" icon={PlayIcon} loading={busy} disabled={busy || !aiReady || reading > 0 || !baseReady || !models}>Start mission</Button></>
    : <Button type="submit" variant="primary" size="base" icon={SparkleIcon} loading={drafting} disabled={busy || drafting || !aiReady || !repoId || !!draftGoalProblem(prompt) || !allowedModels.length}>{plan ? 'Plan again' : 'Plan mission'}</Button>;

  return <section className={`proposal-create proposal-create-${entry}`}>
    <button className="header-back" disabled={busy} onClick={onBack}><ArrowLeftIcon size={13} />{repositoryId ? 'Back to repository missions' : 'Back to missions'}</button>
    <div className="page-heading proposal-heading"><div><h1>New mission</h1><p>{entry === 'auto' ? 'Describe the goal. Gitflare plans the agents, models and coordinator.' : 'Define the outcome and give each agent a part.'}</p></div>{canContribute && repositories.length > 0 && <div className="proposal-entry" role="radiogroup" aria-label="Planning mode">{(['auto', 'manual'] as const).map(value => <label key={value} className={entry === value ? 'selected' : ''}><input type="radio" name="proposal-entry" checked={entry === value} disabled={busy} onChange={() => { setEntry(value); setError(''); }} />{value === 'auto' ? 'Auto' : 'Manual'}</label>)}</div>}</div>
    {!canContribute ? <div className="error-notice" role="alert">Contribute permission is required to create a mission.</div> : !repositories.length ? <section className="panel proposal-no-repository"><GitBranchIcon size={28} /><h2>Create a repository first</h2><p>A mission needs a repository for its source, agent streams and checks.</p><Button variant="primary" size="base" icon={PlusIcon} onClick={onCreateRepository}>Create repository</Button></section> : <form noValidate={false} onSubmit={event => void submit(event)}>
      <div className="proposal-create-layout"><div className="proposal-main-fields">{entry === 'auto' ? autoForm : manualForm}</div><aside className="panel proposal-process"><div className="panel-header"><h2>How it runs</h2></div><ol>{entry === 'auto' ? <><li><strong>Plan</strong><p>Gitflare splits the goal and picks a model for each task. Nothing runs yet.</p></li><li><strong>Start</strong><p>Agents work in isolated forks, three at a time. The coordinator goes last.</p></li><li><strong>Review and land</strong><p>Check the combined candidate, then approve the exact revision.</p></li></> : <><li><strong>Create the draft</strong><p>Save the outcome and assignments. No agents start yet.</p></li><li><strong>Start the agents</strong><p>Choose Start on the mission page. Up to three agents work at once.</p></li><li><strong>Review and land</strong><p>Check the combined changes, then approve the exact revision.</p></li></>}</ol><div className="proposal-baseline"><div className="proposal-baseline-heading"><h3>Git base</h3><Button type="button" variant="secondary" size="base" icon={ArrowClockwiseIcon} disabled={busy || baseLoading || !repoId} loading={baseLoading} onClick={() => setBaseRefresh(value => value + 1)}>{baseError ? "Retry" : "Refresh base"}</Button></div><div className="proposal-target-branch"><GitBranchIcon size={16} aria-hidden="true" /><span>Target stream</span><strong>{loadedBase?.branch ?? repository?.defaultBranch ?? "Choose a repository"}</strong></div>{baseLoading ? <p role="status">Loading current HEAD…</p> : baseError ? <div><p className="proposal-base-error" role="alert">{baseError}</p>{(emptyRepository || importEligible) && <><p>This repository needs its first revision before agents can work.</p>{canManage && repository ? <><Button type="button" variant="secondary" size="base" disabled={busy} onClick={() => setImporting(value => !value)}>{importing ? 'Hide source import' : 'Import initial source ZIP'}</Button>{importing && <div className="proposal-inline-import"><p>This commits the ZIP as the repository's first source. It is separate from context files and cannot replace populated code. Your mission fields are kept.</p><RepositoryImport repository={repository} canManage={canManage} canContribute={canContribute} onBack={() => setImporting(false)} onImported={() => { setImporting(false); setBaseStale(false); setBaseRefresh(value => value + 1); }} onCreateProposal={() => setImporting(false)} /></div>}</> : <p>Ask a workspace owner to import repository code, or push an initial revision.</p>}</>}</div> : loadedBase ? <><dl><dt>Current HEAD</dt><dd><code>{loadedBase.commitSha}</code></dd>{loadedBase.commitMessage && <><dt>Latest revision</dt><dd className="proposal-commit-message">{loadedBase.commitMessage}</dd></>}{loadedBase.author && <><dt>Author</dt><dd>{loadedBase.author}</dd></>}{loadedBase.date && !Number.isNaN(Date.parse(loadedBase.date)) && <><dt>Committed</dt><dd>{new Date(loadedBase.date).toLocaleString()}</dd></>}</dl>{importEligible && <>{canManage && repository ? <><Button type="button" variant="secondary" size="base" disabled={busy} onClick={() => setImporting(value => !value)}>{importing ? 'Hide source import' : 'Import initial source ZIP'}</Button>{importing && <div className="proposal-inline-import"><p>This commits the ZIP as the repository's first source. It is separate from context files and cannot replace populated code. Your mission fields are kept.</p><RepositoryImport repository={repository} canManage={canManage} canContribute={canContribute} onBack={() => setImporting(false)} onImported={() => { setImporting(false); setBaseStale(false); setBaseRefresh(value => value + 1); }} onCreateProposal={() => setImporting(false)} /></div>}</> : null}</>}{baseStale && <p className="proposal-base-error" role="alert">The stream changed. Refresh the base and review the new HEAD. Your draft is preserved.</p>}<p>Agents are pinned to the revision present when they start.</p></> : <p>Choose a repository to load its Git base.</p>}</div></aside></div>
      {!aiReady && <div className="error-notice" role="alert">Add your AI key to start missions. <a href="/settings/models">AI model settings</a></div>}
      {modelError && <div className="error-notice" role="alert">{modelError} <a href="/settings/models">AI model settings</a></div>}
      {error && <div className="error-notice" role="alert">{error}</div>}
      <div className="proposal-create-footer"><p><ShieldCheckIcon size={17} aria-hidden="true" />{entry === 'auto' ? (currentPlan ? 'Start runs the agents. Nothing lands without your approval.' : 'Planning makes one model call. Nothing runs yet.') : 'Agents start only after you choose Start.'}</p><div><Button type="button" variant="secondary" size="base" disabled={busy} onClick={onBack}>Cancel</Button>{entry === 'auto' ? autoAction : <Button type="submit" variant="primary" size="base" loading={busy} disabled={busy || !aiReady || reading > 0 || !baseReady || !models || agents.some(agent => !models.models.some(model => model.id === (agent.model ?? defaultModel)))}>Create mission draft</Button>}</div></div>
    </form>}
  </section>;
}
