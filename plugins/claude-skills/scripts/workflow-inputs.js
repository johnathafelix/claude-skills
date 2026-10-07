// Inlined by stage-workflow.js; the Workflow sandbox has no filesystem imports.
function reviewPath(value, repoDir = '') {
  if (typeof value !== 'string' || !value || /[\0\\]/.test(value)) return null
  function collapse(path) {
    const parts = []
    for (const part of path.split('/')) {
      if (!part || part === '.') continue
      if (part === '..') { if (!parts.length) return null; parts.pop() }
      else parts.push(part)
    }
    return (path.startsWith('/') ? '/' : '') + parts.join('/')
  }
  let file = collapse(value)
  const root = repoDir ? collapse(repoDir) : ''
  if (!file || file === '/' || (repoDir && (!root || !root.startsWith('/')))) return null
  if (file.startsWith('/')) {
    if (!root) return null // Absolute scopes need the explicit checkout root.
    // macOS exposes these temp directories through both names. The pinned root is realpath.
    if (root.startsWith('/private/tmp/') && file.startsWith('/tmp/')) file = '/private' + file
    if (root.startsWith('/private/var/') && file.startsWith('/var/')) file = '/private' + file
    const prefix = root === '/' ? '/' : root + '/'
    if (!file.startsWith(prefix)) return null
    file = file.slice(prefix.length)
  }
  return file || null
}

function reviewFinding(raw, repoDir, external = false) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { errors: ['finding must be an object'] }
  const finding = { ...raw, file: reviewPath(raw.file, repoDir) }
  if (external) {
    finding.description = raw.description || raw.summary
    const trigger = raw.failure_scenario || raw.failureScenario || raw.rationale
    if (typeof trigger === 'string' && trigger.trim() && typeof finding.description === 'string' && !finding.description.includes(trigger)) {
      finding.description += `\nTrigger: ${trigger}`
    }
    finding.suggestedFix = raw.suggestedFix || raw.action
    finding.severity = ({ error: 'issue', warning: 'nit', info: 'nit' })[raw.severity] || raw.severity
    finding.dimension = raw.dimension || (raw.rule ? `external/${raw.rule}` : 'external')
  }
  const errors = []
  if (!finding.file) errors.push('file must be a path inside repoDir (absolute paths require repoDir)')
  if (!Number.isInteger(finding.line) || finding.line < 1) errors.push('line must be a positive integer')
  if (!['issue', 'nit'].includes(finding.severity)) errors.push('severity must be issue or nit')
  for (const key of ['description', 'suggestedFix']) {
    if (typeof finding[key] !== 'string' || !finding[key].trim()) errors.push(`${key} must be non-empty text`)
  }
  return { finding, errors }
}

function reviewNitPolicy(value, fallback = 'material') {
  const policy = value === undefined ? fallback : value
  if (!['material', 'all'].includes(policy)) throw new Error('nitPolicy must be material or all')
  return policy === 'all' ? '' :
    'Prioritize correctness, security and regression findings. Report at most two nits in this pass, only with a concrete maintenance or testing cost introduced by the change. Skip mechanical formatting, missing routine doc comments, preferred syntax, trivial test-edge coverage and speculative helper extraction. A misleading contract comment, duplicated logic that can drift, or an assertion hiding a realistic failure can qualify; explain the cost. This nit limit never excludes a correctness issue. Prefer no nits over filling a quota.'
}
