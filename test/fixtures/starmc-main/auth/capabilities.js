const ROLE_CAPABILITIES = {
  superadmin: [
    'canManageSuperAdmins',
    'canControlCircuitBreaker',
  ],
  admin: [
    'canViewReviewerCenter',
    'canReviewSubmissions',
    'canModerateReports',
    'canManageUsers',
    'canManageSiteConfig',
    'canViewTelemetry',
    'canViewAuthxEvents',
    'canManageAuthxAdmin',
    'canViewMcResetEvents',
    'canManageSecurityRules',
    'canReplayWebhooks',
    'canViewAuditLogs',
    'canManageTasks',
    'canRollbackSkinVersion',
    'canSkipSkinReview',
  ],
  moderator: [
    'canViewReviewerCenter',
    'canReviewSubmissions',
    'canModerateReports',
    'canViewAuditLogs',
    'canManageTasks',
    'canRollbackSkinVersion',
  ],
  reviewer: [
    'canViewReviewerCenter',
    'canReviewSubmissions',
    'canModerateReports',
    'canViewAuditLogs',
    'canRollbackSkinVersion',
  ],
  sponsor: ['canSkipSkinReview'],
  user: [],
}

export function roleSetOf(user) {
  const roles = Array.isArray(user?.roles) ? user.roles : []
  const set = new Set(roles.map((role) => String(role || '').trim().toLowerCase()).filter(Boolean))
  if (set.has('superadmin')) set.add('admin')
  return set
}

export function buildCapabilityMatrix(user) {
  const roles = [...roleSetOf(user)]
  const granted = new Set()
  for (const role of roles) {
    for (const capability of ROLE_CAPABILITIES[role] || []) granted.add(capability)
  }

  const capabilities = Object.fromEntries(
    Object.values(ROLE_CAPABILITIES)
      .flat()
      .map((capability) => [capability, granted.has(capability)])
  )

  return { roles, capabilities }
}

export function hasCapability(user, capability) {
  return buildCapabilityMatrix(user).capabilities[capability] === true
}
