import { existsSync, readFileSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { basename, resolve } from 'node:path'
import { sha256 } from '../protocol/index.js'

/**
 * A deliberately small, factual graph linking the files and reports a Builder
 * sees.  It is navigation evidence, not a planner and never contains a repair
 * recommendation.  The shape is inspired by the public Apache-2.0 Tycho
 * workspace contract (tool schemas + verifier state), but is Loom-native.
 */
export type BuilderArtifactRole =
  | 'actor_handoff'
  | 'target_before'
  | 'failure_report'
  | 'prior_run'
  | 'prior_run_asset'
  | 'workspace'
  | 'source'
  | 'candidate'
  | 'submission'
  | 'verification_report'
  | 'tool_result'

export type BuilderProvenanceRelation = 'consumes' | 'produces' | 'tests' | 'reports_on' | 'derived_from'

export interface BuilderArtifact {
  schemaVersion: 1
  /** Stable for the same role/path/hash; it is safe to quote in a later tool call. */
  id: string
  role: BuilderArtifactRole
  path?: string
  hash?: string
  exists?: boolean
  sourceRunId?: string
  summary: string
}

export interface BuilderProvenanceEdge {
  schemaVersion: 1
  from: string
  relation: BuilderProvenanceRelation
  to: string
  evidence?: string
}

export interface BuilderProvenanceGraph {
  schemaVersion: 1
  runId: string
  generatedAt: string
  artifacts: BuilderArtifact[]
  edges: BuilderProvenanceEdge[]
}

export interface BuilderProvenanceSeed {
  runId: string
  actorPath: string
  targetBeforePath: string
  previousAttemptPath: string
  previousRunPath: string
  workspacePath: string
  proposalPath: string
  submissionManifestPath: string
  actor: Record<string, unknown>
  previousAttempt?: Record<string, unknown>
  previousRun?: {
    runId: string
    assets: Array<{ name: string; path: string; exists: boolean; hash?: string }>
  }
}

export function createBuilderProvenance(seed: BuilderProvenanceSeed): BuilderProvenanceGraph {
  const graph: BuilderProvenanceGraph = {
    schemaVersion: 1,
    runId: seed.runId,
    generatedAt: new Date().toISOString(),
    artifacts: [],
    edges: [],
  }
  const actor = addArtifact(graph, artifact('actor_handoff', seed.actorPath, sha256(seed.actor), 'Immutable actor handoff captured at run creation.'))
  const target = addArtifact(graph, artifact('target_before', seed.targetBeforePath, undefined, 'Immutable target/baseline captured at run creation.'))
  const workspace = addArtifact(graph, artifact('workspace', seed.workspacePath, undefined, 'Persistent Builder-owned workspace for experiments and candidate files.'))
  const submission = addArtifact(graph, artifact('submission', seed.proposalPath, undefined, 'Frozen proposal draft; it is not an approval or installation.'))
  const manifest = addArtifact(graph, artifact('verification_report', seed.submissionManifestPath, undefined, 'Hash-bound submission manifest consumed by independent deliberation.'))
  addEdge(graph, { from: submission.id, relation: 'derived_from', to: actor.id })
  addEdge(graph, { from: submission.id, relation: 'consumes', to: target.id })
  addEdge(graph, { from: manifest.id, relation: 'reports_on', to: submission.id })
  addEdge(graph, { from: workspace.id, relation: 'produces', to: submission.id })

  if (seed.previousAttempt) {
    const failure = addArtifact(graph, artifact('failure_report', seed.previousAttemptPath, sha256(seed.previousAttempt), 'Immutable verifier/gate/oracle feedback from the prior attempt.'))
    addEdge(graph, { from: failure.id, relation: 'reports_on', to: submission.id })
    const candidates = extractArtifactPaths(seed.previousAttempt, /candidate|artifact/i)
    for (const candidatePath of candidates) {
      const candidate = addArtifact(graph, artifact('candidate', candidatePath, fileHash(candidatePath), 'Candidate or input artifact named by prior feedback.'))
      // The failure consumes the exact candidate it observed.  This gives a
      // model a factual error -> candidate -> producer route without telling
      // it what edit to make.
      addEdge(graph, { from: failure.id, relation: 'consumes', to: candidate.id, evidence: seed.previousAttemptPath })
    }
    for (const oraclePath of extractArtifactPaths(seed.previousAttempt, /oracle|verifier|test/i)) {
      const oracle = addArtifact(graph, artifact('source', oraclePath, fileHash(oraclePath), 'Oracle, verifier, or test artifact named by prior feedback.'))
      for (const candidate of graph.artifacts.filter((artifact) => artifact.role === 'candidate' && candidates.includes(artifact.path ?? ''))) {
        addEdge(graph, { from: oracle.id, relation: 'tests', to: candidate.id, evidence: seed.previousAttemptPath })
      }
    }
  }
  if (seed.previousRun) {
    const priorRun = addArtifact(graph, {
      schemaVersion: 1,
      id: stableArtifactId('prior_run', undefined, seed.previousRun.runId),
      role: 'prior_run',
      sourceRunId: seed.previousRun.runId,
      summary: `Read-only prior immutable run ${seed.previousRun.runId}.`,
    })
    for (const asset of seed.previousRun.assets) {
      const node = addArtifact(graph, artifact('prior_run_asset', asset.path, asset.hash, `Read-only prior-run asset: ${asset.name}.`, seed.previousRun.runId, asset.exists))
      addEdge(graph, { from: priorRun.id, relation: 'produces', to: node.id })
      if (node.role === 'prior_run_asset' && /candidate|proposal|submission/i.test(asset.name)) {
        addEdge(graph, { from: node.id, relation: 'derived_from', to: submission.id })
      }
    }
  }
  return graph
}

export function addObservedArtifact(graph: BuilderProvenanceGraph, role: BuilderArtifactRole, path: string, summary: string, sourceRunId?: string): BuilderArtifact {
  const node = addArtifact(graph, artifact(role, path, fileHash(path), summary, sourceRunId))
  graph.generatedAt = new Date().toISOString()
  return node
}

export function traceBuilderArtifact(graph: BuilderProvenanceGraph, selector: string): Record<string, unknown> {
  const selected = graph.artifacts.find((artifact) => artifact.id === selector || artifact.path === selector)
  if (!selected) {
    return {
      found: false,
      selector,
      knownArtifacts: graph.artifacts.slice(0, 80).map(({ id, role, path, summary }) => ({ id, role, path, summary })),
    }
  }
  const edges = graph.edges.filter((edge) => edge.from === selected.id || edge.to === selected.id)
  const relatedIds = new Set(edges.flatMap((edge) => [edge.from, edge.to]))
  relatedIds.delete(selected.id)
  return {
    found: true,
    artifact: selected,
    edges,
    relatedArtifacts: graph.artifacts.filter((artifact) => relatedIds.has(artifact.id)),
  }
}

/** Inspect a file as an interface-bearing artifact, rather than a raw blob only. */
export function inspectBuilderFile(path: string): Record<string, unknown> {
  const file = resolve(path)
  if (!existsSync(file) || !statSync(file).isFile()) throw new Error('file is unavailable')
  const content = readFileSync(file, 'utf8')
  const lines = content.split('\n')
  return {
    path: file,
    basename: basename(file),
    bytes: Buffer.byteLength(content, 'utf8'),
    lines: lines.length,
    hash: sha256(content),
    language: languageForPath(file),
    exports: findMatches(content, /(?:export\s+(?:async\s+)?(?:function|class|const|let|var)\s+|module\.exports\s*=\s*|exports\.)([A-Za-z_$][\w$]*)/g),
    imports: findMatches(content, /(?:from\s+|require\()['"]([^'"]+)['"]/g),
    functions: findMatches(content, /(?:async\s+)?function\s+([A-Za-z_$][\w$]*)|(?:^|\n)\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^\n)]*\)\s*\{/g),
    preview: content.slice(0, 16_000),
    truncated: content.length > 16_000,
  }
}

/** Read-only, argv-based text search. No shell is involved. */
export function searchBuilderText(query: string, roots: string[], maxResults = 40): Record<string, unknown> {
  const normalizedQuery = query.trim()
  if (!normalizedQuery) throw new Error('search_text requires a non-empty query')
  const normalizedRoots = [...new Set(roots.map((root) => resolve(root)))].filter((root) => existsSync(root))
  if (normalizedRoots.length === 0) throw new Error('search_text requires at least one available root')
  const limit = Math.max(1, Math.min(200, Math.floor(maxResults)))
  const result = spawnSync('rg', [
    '--line-number', '--no-heading', '--color', 'never', '--max-count', String(limit),
    '--glob', '!node_modules', '--glob', '!dist', normalizedQuery, ...normalizedRoots,
  ], { encoding: 'utf8', timeout: 30_000, maxBuffer: 256 * 1024 })
  const stdout = String(result.stdout ?? '')
  const matches = stdout.split('\n').filter(Boolean).slice(0, limit).map((line) => {
    const match = /^(.*?):(\d+):(.*)$/.exec(line)
    return match ? { path: match[1], line: Number(match[2]), text: match[3] } : { text: line }
  })
  return {
    query: normalizedQuery,
    roots: normalizedRoots,
    matches,
    truncated: matches.length >= limit,
    exitCode: result.status,
    ...(result.error ? { error: String(result.error) } : {}),
    ...(result.stderr ? { stderr: String(result.stderr).slice(-4_000) } : {}),
  }
}

function artifact(role: BuilderArtifactRole, path: string, hash: string | undefined, summary: string, sourceRunId?: string, exists?: boolean): BuilderArtifact {
  return {
    schemaVersion: 1,
    id: stableArtifactId(role, path, hash),
    role,
    path,
    ...(hash ? { hash } : {}),
    ...(exists === undefined ? { exists: existsSync(path) } : { exists }),
    ...(sourceRunId ? { sourceRunId } : {}),
    summary,
  }
}

function addArtifact(graph: BuilderProvenanceGraph, value: BuilderArtifact): BuilderArtifact {
  const existing = graph.artifacts.find((artifact) => artifact.id === value.id)
  if (existing) return existing
  graph.artifacts.push(value)
  return value
}

function addEdge(graph: BuilderProvenanceGraph, value: Omit<BuilderProvenanceEdge, 'schemaVersion'>): void {
  if (graph.edges.some((edge) => edge.from === value.from && edge.relation === value.relation && edge.to === value.to && edge.evidence === value.evidence)) return
  graph.edges.push({ schemaVersion: 1, ...value })
}

function stableArtifactId(role: BuilderArtifactRole, path?: string, hash?: string): string {
  return `artifact-${sha256({ role, path: path ? resolve(path) : undefined, hash }).slice(0, 20)}`
}

function fileHash(path: string): string | undefined {
  try {
    return existsSync(path) && statSync(path).isFile() ? sha256(readFileSync(path, 'utf8')) : undefined
  } catch {
    return undefined
  }
}

function extractArtifactPaths(value: unknown, keyMatcher: RegExp, key = '', out = new Set<string>()): string[] {
  if (typeof value === 'string') {
    if (keyMatcher.test(key) && (value.startsWith('/') || value.startsWith('.'))) out.add(resolve(value))
    return [...out]
  }
  if (Array.isArray(value)) {
    for (const item of value) extractArtifactPaths(item, keyMatcher, key, out)
  } else if (value && typeof value === 'object') {
    for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) extractArtifactPaths(child, keyMatcher, childKey, out)
  }
  return [...out]
}

function languageForPath(path: string): string {
  const suffix = path.split('.').pop()?.toLowerCase()
  return suffix === 'ts' || suffix === 'tsx' ? 'typescript'
    : suffix === 'js' || suffix === 'mjs' || suffix === 'cjs' ? 'javascript'
      : suffix === 'py' ? 'python'
        : suffix === 'json' ? 'json'
          : suffix === 'md' ? 'markdown' : 'text'
}

function findMatches(content: string, pattern: RegExp): string[] {
  const matches = new Set<string>()
  for (const match of content.matchAll(pattern)) {
    const value = match.slice(1).find((item): item is string => typeof item === 'string' && Boolean(item.trim()))
    if (value) matches.add(value.slice(0, 240))
    if (matches.size >= 80) break
  }
  return [...matches]
}
