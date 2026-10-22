import { describe, expect, it, vi } from 'vitest';
import type { ArtifactRepo, ArtifactsBinding } from '../src/worker/artifacts';
import { discoverRepositorySkills, listRepositorySkills, loadRepositorySkillContext, skillMetadata, skillFrontmatter } from '../src/worker/repository-skills';

const sha = 'a'.repeat(40);
function source(trees: Record<string, ArtifactsTreeEntry[]>, files: Record<string, Blob>) {
  return { log: vi.fn(async () => [{ hash: sha, treeHash: 'root', message: '' }]), readTree: vi.fn(async (hash: string) => trees[hash] ?? null), readFile: vi.fn(async ({ path }: { ref: string; path: string }) => files[path] ?? null) } as unknown as ArtifactRepo;
}
function entry(name: string, type: ArtifactsTreeEntry['type'], hash = name): ArtifactsTreeEntry { return { name, type, hash, mode: type === 'tree' ? '040000' : '100644' }; }

describe('repository skill discovery', () => {
  it('keeps the disposable repository handle alive until discovery completes', async () => {
    let disposed = false;
    const repository = source({ root: [entry('skills', 'tree')], skills: [entry('SKILL.md', 'blob')] }, {});
    repository[Symbol.dispose] = () => { disposed = true; };
    repository.log = async () => { await Promise.resolve(); if (disposed) throw new Error('Repository disposed'); return [{ hash: sha, treeHash: 'root', message: '' }]; };
    repository.readFile = async () => { await Promise.resolve(); if (disposed) throw new Error('Repository disposed'); return new Blob(['---\nname: guide\n---\nInstructions']); };
    const artifacts = { get: async () => repository } as unknown as ArtifactsBinding;
    const result = await listRepositorySkills(artifacts, { name: 'example', provider: 'artifacts', defaultBranch: 'main' });
    expect(result.skills).toHaveLength(1);
    expect(disposed).toBe(true);
  });
  it('resolves once and reads nested skill files only at the immutable commit', async () => {
    const repository = source({ root: [entry('docs', 'tree'), entry('outside', 'tree'), entry('.agents', 'tree')], docs: [entry('skills', 'tree', 'docs-skills')], 'docs-skills': [entry('guide', 'tree')], guide: [entry('SKILL.md', 'blob'), entry('linked', 'symlink')], '.agents': [entry('skills', 'tree', 'agent-skills')], 'agent-skills': [entry('SKILL.md', 'blob')] }, { 'docs/skills/guide/SKILL.md': new Blob(['---\nname: Guide\ndescription: Follow repository rules\n---\nInstructions']), '.agents/skills/SKILL.md': new Blob(['# Another guide']) });
    const result = await discoverRepositorySkills(repository, 'feature');
    expect(repository.log).toHaveBeenCalledExactlyOnceWith({ ref: 'feature', limit: 1 });
    expect(result.skills.map(item => item.path)).toEqual(['.agents/skills/SKILL.md', 'docs/skills/guide/SKILL.md']);
    expect(result.skills[1].name).toBe('Guide');
    expect(repository.readFile).toHaveBeenCalledWith({ ref: sha, path: 'docs/skills/guide/SKILL.md' });
    expect(repository.readTree).not.toHaveBeenCalledWith('outside');
    expect(result.truncated).toBe(false);
  });
  it('skips binary and oversized files without pretending they were discovered', async () => {
    const repository = source({ root: [entry('skills', 'tree')], skills: [entry('binary', 'tree'), entry('large', 'tree')], binary: [entry('SKILL.md', 'blob')], large: [entry('SKILL.md', 'blob')] }, { 'skills/binary/SKILL.md': new Blob([new Uint8Array([255])]), 'skills/large/SKILL.md': new Blob(['a'.repeat(65537)]) });
    expect(await discoverRepositorySkills(repository, 'main')).toMatchObject({ skills: [], skipped: 2, truncated: false });
  });
  it('reports a traversal bound and does not read an oversized tree', async () => {
    const repository = source({ root: [entry('skills', 'tree')], skills: Array.from({ length: 5001 }, (_, i) => entry(String(i), 'tree')) }, {});
    expect(await discoverRepositorySkills(repository, 'main')).toMatchObject({ skills: [], truncated: true });
    expect(repository.readTree).toHaveBeenCalledTimes(2);
  });
  it('does not follow symlink skill files', async () => {
    const repository = source({ root: [entry('skills', 'tree')], skills: [entry('SKILL.md', 'symlink')] }, {});
    expect((await discoverRepositorySkills(repository, 'main')).skills).toEqual([]);
    expect(repository.readFile).not.toHaveBeenCalled();
  });
  it('rejects an empty or missing reference', async () => {
    const repository = source({}, {}); vi.mocked(repository.log).mockResolvedValue([]);
    await expect(discoverRepositorySkills(repository, 'main')).rejects.toMatchObject({ status: 404, code: 'REF_NOT_FOUND' });
  });
});

describe('skill metadata', () => {
  it('reads simple quoted and folded metadata, with directory fallback', () => {
    expect(skillMetadata('---\nname: "Rules"\ndescription: >\n  First line\n  second line\n---\nText', 'skills/rules/SKILL.md')).toEqual({ name: 'Rules', description: 'First line second line', path: 'skills/rules/SKILL.md' });
    expect(skillFrontmatter("---\nname: \"\\\"Quoted\\\"\"\ndescription: 'Don''t cross lines'\n---\n")).toEqual({ name: "\"Quoted\"", description: "Don't cross lines" });
    expect(skillFrontmatter('---\nname:\ndescription: Valid\n---\n')).toEqual({ name: '', description: 'Valid' });
    expect(skillMetadata('# No metadata', 'docs/skills/guide/SKILL.md').name).toBe('guide');
  });
});


describe('pinned repository skill runtime context', () => {
  it('loads complete instructions and content hashes from exactly the base commit', async () => {
    const content = '---\nname: safe-guide\ndescription: Use the guide\n---\nFollow these task instructions.';
    const repository = source({ root: [entry('skills', 'tree')], skills: [entry('guide', 'tree')], guide: [entry('SKILL.md', 'blob')] }, { 'skills/guide/SKILL.md': new Blob([content]) });
    const result = await loadRepositorySkillContext(repository, sha);
    expect(repository.log).toHaveBeenCalledExactlyOnceWith({ ref: sha, limit: 1 });
    expect(repository.readFile).toHaveBeenCalledWith({ ref: sha, path: 'skills/guide/SKILL.md' });
    expect(result.skills[0]).toMatchObject({ name: 'safe-guide', path: 'skills/guide/SKILL.md', commitSha: sha, content, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    const { createHash } = await import('node:crypto');
    expect(result.skills[0]!.sha256).toBe(createHash('sha256').update(content).digest('hex'));
    expect(result.warnings).toEqual([]);
  });

  it('discloses omitted files without truncating their instruction text', async () => {
    const repository = source({ root: [entry('skills', 'tree')], skills: [entry('first', 'tree'), entry('second', 'tree'), entry('third', 'tree')], first: [entry('SKILL.md', 'blob')], second: [entry('SKILL.md', 'blob')], third: [entry('SKILL.md', 'symlink')] }, { 'skills/first/SKILL.md': new Blob(['x'.repeat(20000)]), 'skills/second/SKILL.md': new Blob(['y'.repeat(20000)]) });
    const result = await loadRepositorySkillContext(repository, sha);
    expect(result.skills).toHaveLength(1);
    expect(result.skills[0]!.content).toBe('x'.repeat(20000));
    expect(result.warnings).toContain('Omitted skills/second/SKILL.md: complete file exceeds the 32768-byte skill context budget.');
    expect(result.warnings).toContain('Skipped skills/third/SKILL.md: skill files must be regular files.');
  });

  it('rejects a substituted immutable reference and discloses invalid content', async () => {
    const repository = source({ root: [entry('skills', 'tree')], skills: [entry('SKILL.md', 'blob')] }, { 'skills/SKILL.md': new Blob([new Uint8Array([255])]) });
    expect((await loadRepositorySkillContext(repository, sha)).warnings).toEqual(['Skipped skills/SKILL.md: invalid UTF-8 or binary skill content.']);
    await expect(loadRepositorySkillContext(repository, 'main')).rejects.toThrow('immutable base commit');
    await expect(loadRepositorySkillContext(repository, 'b'.repeat(40))).rejects.toThrow('pinned base commit');
  });
});
