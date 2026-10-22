import { listRepositorySkills } from '../repository-skills';
import { logFailure } from '../log';
import { createArtifactsRepository, repositoryHead } from '../artifacts';
import { ApiError, repositoryName, requireString, storageRepositoryName } from '../domain';
import { executionReadiness } from '../execution';
import { validateRepositoryInitialization, initializeArtifactsRepository } from '../repository-initialization';
import { validateRepositorySkillChange, verifyRepositorySkillChange } from '../skill-edit';
import { RepositoryImportFailure, buildImportPack, importFingerprint, inspectRepositoryImport, parseImportArchive, pushRepositoryImport, validateImportInput } from '../repository-import';
import { triggerMirrorSync } from '../github-mirror-runtime';
import { withInstall } from '../check-settings';
import { browseRepository } from '../source-browse';
import { type RouteContext, records, requireRepository, currentRepository, inBackground } from '../route-context';

export async function repositoryContent(context: RouteContext, repositoryMatch: RegExpExecArray): Promise<Response> {
  const { url, env, principal, access, catalog } = context;
  const repository = await requireRepository(catalog, repositoryMatch[1]);
  await access.authorize(principal, 'read', 'repository', repository.id);
  if (repositoryMatch[2] === 'import') {
    const coordinator = records(env, repository.id);
    const { bootstrap: _bootstrap, ...status } = await inspectRepositoryImport(env.ARTIFACTS, repository, await coordinator.repositoryBootstrapSha());
    return Response.json(status);
  }
  if (repositoryMatch[2] === 'proposal-base') {
    if (!env.ARTIFACTS || repository.provider !== 'artifacts') throw new ApiError(409, 'REPOSITORY_NOT_CONNECTED', 'Connect an Artifacts repository before creating a proposal.');
    using source = await env.ARTIFACTS.get(repository.name);
    const commit = (await source.log({ ref: repository.defaultBranch, limit: 1 }))[0];
    if (!commit) throw new ApiError(409, 'EMPTY_REPOSITORY', 'Push an initial commit before creating a proposal.');
    return Response.json({ branch: repository.defaultBranch, commitSha: commit.hash, commitMessage: commit.message });
  }
  if (repositoryMatch[2] === 'skills') return Response.json(await listRepositorySkills(env.ARTIFACTS, repository, url.searchParams.get('ref') ?? undefined));
  const coordinator = records(env, repository.id);
  return browseRepository(env, repository, repositoryMatch[2], url, { find: (commitSha) => coordinator.missionCandidate(commitSha), matching: (prefix) => coordinator.missionCandidateShas(prefix), authorize: (missionId) => access.authorize(principal, 'read', 'repository', repository.id, missionId) });
}

export async function repositoryWrites(context: RouteContext, repositoryMatch: RegExpExecArray | null, key: string, body: Record<string, unknown>): Promise<Response | null> {
  const { url, env, ctx, principal, access, catalog, local } = context;
  if (repositoryMatch?.[2] === 'import') {
    const repository = await requireRepository(catalog, repositoryMatch[1]);
    await access.authorize(principal, 'manage', 'repository', repository.id);
    if (!env.ARTIFACTS || repository.provider !== 'artifacts') throw new ApiError(409, 'REPOSITORY_NOT_CONNECTED', 'Connect an Artifacts repository before importing code.');
    const input = validateImportInput(body), fingerprint = importFingerprint(input);
    const coordinator = records(env, repository.id);
    if (input.dryRun) {
      const archive = parseImportArchive(input.archiveBase64, input.keep);
      const { bootstrap: _bootstrap, ...state } = await inspectRepositoryImport(env.ARTIFACTS, repository, await coordinator.repositoryBootstrapSha());
      const preview: import('../repository-import').ImportPreview = { dryRun: true, allowed: state.allowed && state.headSha === input.expectedHeadSha, reason: state.headSha !== input.expectedHeadSha ? 'The repository commit changed. Refresh before importing.' : state.reason, headSha: state.headSha, files: archive.files.map(file => file.path), skipped: archive.skipped, exclusions: archive.exclusions, warnings: archive.warnings, install: archive.install };
      return Response.json(preview);
    }
    if (input.enableInstall && (principal.role !== 'Owner' || principal.credentialId)) throw new ApiError(403, 'OWNER_REQUIRED', 'Only a workspace Owner can turn on dependency install. Import without enableInstall, or ask an Owner.');
    const enableInstall = async (result: import('../repository-import').ImportResult) => {
      const suggestion = result.install;
      if (!input.enableInstall || !suggestion || suggestion.automatic) return result;
      const current = await coordinator.getCheckSettings();
      if (current?.install?.value !== suggestion.manager) {
        await coordinator.setCheckSettings(`${key}:install`, withInstall(current, { value: suggestion.manager, updatedAt: new Date().toISOString(), updatedBy: principal.userId }), principal.userId);
        await access.auditRepositoryChange(principal, 'repository.check-settings.install', repository.id);
      }
      return { ...result, install: { ...suggestion, enabled: true, message: `Dependency install with ${suggestion.manager}${suggestion.lockfile ? ` from ${suggestion.lockfile}` : ''} is on for checks. Change it in the repository check settings.` } };
    };
    const reconcile = async (receipt: import('../repository-import').ImportReceipt) => {
      if (receipt.rejection) throw new ApiError(receipt.rejection.status, receipt.rejection.code, receipt.rejection.message);
      if (receipt.result) { await catalog.saveRepository(receipt.result.repository); return receipt.result; }
      const actual = await repositoryHead(env.ARTIFACTS!, repository.name, repository.defaultBranch);
      if (!receipt.candidateSha || actual !== receipt.candidateSha) throw new ApiError(409, 'IMPORT_PENDING', 'This import is pending or has an uncertain outcome. Its canonical write will not be repeated. Retry the original request after the commit becomes visible.');
      const updated = { ...repository, headSha: actual, updatedAt: new Date().toISOString() };
      const result = await coordinator.completeRepositoryImport(key, fingerprint, updated);
      await catalog.saveRepository(updated);
      return result;
    };
    const previous = await coordinator.getImportRequest(key, fingerprint);
    if (previous) return Response.json(await enableInstall(await reconcile(previous)));
    const archive = parseImportArchive(input.archiveBase64, input.keep);
    const state = await inspectRepositoryImport(env.ARTIFACTS, repository, await coordinator.repositoryBootstrapSha());
    if (state.headSha !== input.expectedHeadSha) throw new ApiError(409, 'STALE_IMPORT_HEAD', 'The repository commit changed. Refresh before importing.');
    if (!state.allowed) throw new ApiError(409, 'IMPORT_NOT_ALLOWED', state.reason);
    const files = [...archive.files, ...state.bootstrap.filter(file => !archive.files.some(imported => imported.path === file.path))];
    buildImportPack(files, input.expectedHeadSha, Math.floor(Date.now() / 1000), input.message);
    const claim = await coordinator.claimRepositoryImport(key, fingerprint);
    if (!claim.claimed) return Response.json(await enableInstall(await reconcile(claim.receipt)));
    const built = buildImportPack(files, input.expectedHeadSha, claim.receipt.timestamp, input.message);
    await coordinator.prepareRepositoryImport(key, fingerprint, built.commitSha, files.map(file => file.path), archive.skipped, { exclusions: archive.exclusions, warnings: archive.warnings, install: archive.install });
    try { await pushRepositoryImport(env.ARTIFACTS, repository, input.expectedHeadSha, built, () => access.check(principal, 'manage', 'repository', repository.id)); }
    catch (error) {
      const actual = await repositoryHead(env.ARTIFACTS, repository.name, repository.defaultBranch).catch(() => null);
      if (actual !== built.commitSha) {
        if (error instanceof RepositoryImportFailure && error.outcome === 'not_pushed') await coordinator.rejectRepositoryImport(key, fingerprint, { status: error.status, code: error.code, message: error.message });
        throw error;
      }
    }
    await inBackground(ctx, triggerMirrorSync(env, repository.id, principal.workspaceId, 'import', [`refs/heads/${repository.defaultBranch}`], ctx));
    return Response.json(await enableInstall(await reconcile({ ...claim.receipt, candidateSha: built.commitSha })));
  }
  if (repositoryMatch?.[2] === 'skills') {
    const repository = await requireRepository(catalog, repositoryMatch[1]);
    await access.check(principal, 'contribute', 'repository', repository.id);
    await access.check(principal, 'execute', 'repository', repository.id);
    const change = validateRepositorySkillChange(body);
    const coordinator = records(env, repository.id);
    const replay = await coordinator.getSkillEditRequest(key, repository.id, change);
    if (replay) return Response.json(replay, { status: 202 });
    const readiness = executionReadiness(env, 'skill-edit');
    if (!readiness.ready || !env.MISSION_WORKFLOW) throw new ApiError(503, 'EXECUTION_NOT_CONFIGURED', `Connect the required services before editing skills: ${[...readiness.missing, ...(!env.MISSION_WORKFLOW ? ['Mission Workflow'] : [])].join(', ')}.`);
    await verifyRepositorySkillChange(env.ARTIFACTS, repository, change);
    await currentRepository(env, repository);
    const mission = await coordinator.createSkillMissionWithDispatch(key, repository.id, change, { principal, workspaceId: principal.workspaceId, creatorId: principal.userId });
    return Response.json(mission, { status: 202 });
  }
  if (url.pathname === '/api/repositories/connect') {
    await access.authorize(principal, 'manage');
    if (principal.workspaceId !== 'legacy') throw new ApiError(403, 'REPOSITORY_OWNERSHIP_REQUIRED', 'Connecting pre-existing shared namespace repositories requires verified ownership; create an isolated repository instead.');
    if (!env.ARTIFACTS) throw new ApiError(503, 'REPOSITORY_SETUP_REQUIRED', 'Connect the Artifacts binding before adding an existing repository.');
    const name = repositoryName(body.name);
    if (/^w-[a-f0-9]{32}-/.test(name)) throw new ApiError(403, 'RESERVED_NAMESPACE', 'Isolated workspace repositories cannot be attached to the legacy workspace.');
    const description = body.description === undefined || body.description === '' ? '' : requireString(body.description, 'Description', 500);
    let verified: { remote: string; defaultBranch: string; headSha: string | null };
    try {
      using source = await env.ARTIFACTS.get(name);
      const info = await source.info();
      verified = { remote: info.remote, defaultBranch: info.defaultBranch || 'main', headSha: (await source.log({ ref: info.defaultBranch || 'main', limit: 1 }))[0]?.hash ?? null };
    } catch (error) {
      logFailure('artifacts_repository_lookup_failed', error, { workspaceId: principal.workspaceId }, 'warn');
      throw new ApiError(404, 'ARTIFACTS_REPOSITORY_NOT_FOUND', 'This repository was not found in the configured Artifacts namespace. Check its name and binding.');
    }
    if (body.remote !== undefined && body.remote !== '' && requireString(body.remote, 'Remote', 2000) !== verified.remote) throw new ApiError(400, 'REMOTE_MISMATCH', 'The supplied remote does not match the verified Artifacts repository.');
    const now = new Date().toISOString();
    const repository = await catalog.connectRepository(key, { id: crypto.randomUUID(), workspaceId: principal.workspaceId, name, description, provider: 'artifacts', ...verified, createdAt: now, updatedAt: now });
    await records(env, repository.id).saveRepository(repository);
    return Response.json(repository, { status: 201 });
  }
  if (url.pathname === '/api/repositories') {
    const initialization = validateRepositoryInitialization(body);
    await access.authorize(principal, 'manage');
    const requestedName = repositoryName(body.name);
    if (principal.workspaceId === 'legacy' && /^w-[a-f0-9]{32}-/.test(requestedName)) throw new ApiError(403, 'RESERVED_NAMESPACE', 'This repository prefix is reserved for isolated workspaces.');
    const name = await storageRepositoryName(principal.workspaceId, requestedName);
    const description = body.description === undefined || body.description === '' ? '' : requireString(body.description, 'Description', 500);
    if (!local && !env.ARTIFACTS) throw new ApiError(503, 'REPOSITORY_SETUP_REQUIRED', 'Connect Artifacts before creating a repository.');
    const now = new Date().toISOString();
    let repository = await catalog.createRepository(key, { id: crypto.randomUUID(), workspaceId: principal.workspaceId, name, ...(name === requestedName ? {} : { displayName: requestedName }), description, defaultBranch: 'main', headSha: null, provider: env.ARTIFACTS ? 'artifacts' : 'local', createdAt: now, updatedAt: now });
    if (repository.provider === 'artifacts') {
      repository = await catalog.getRepository(repository.id) ?? repository;
      if (!repository.remote) {
        if (!await catalog.claimProvision(repository.id)) throw new ApiError(409, 'PROVISIONING_PENDING', 'This repository is being provisioned or needs reconciliation after an interrupted request. Its creation will not be repeated.');
        try {
          const provisioned = await createArtifactsRepository(env, { name, description });
          repository = { ...repository, ...provisioned, updatedAt: new Date().toISOString() };
          await catalog.saveRepository(repository);
        } catch (error) {
          logFailure('artifacts_repository_provision_failed', error, { workspaceId: principal.workspaceId, repositoryId: repository.id });
          throw new ApiError(503, 'PROVISIONING_INTERRUPTED', 'Repository provisioning did not finish. Inspect its Artifacts state before retrying to avoid creating duplicate resources.');
        }
      }
    }
    if (env.ARTIFACTS && repository.provider === 'artifacts' && !repository.headSha) {
      const initialized = await initializeArtifactsRepository(env.ARTIFACTS, repository.name, { name: requestedName, description, options: initialization });
      if (initialized.headSha) { await records(env, repository.id).saveRepositoryBootstrapSha(initialized.headSha); repository = { ...repository, headSha: initialized.headSha, updatedAt: new Date().toISOString() }; await catalog.saveRepository(repository); }
    }
    await records(env, repository.id).saveRepository(repository);
    return Response.json(repository, { status: 201 });
  }
  return null;
}
