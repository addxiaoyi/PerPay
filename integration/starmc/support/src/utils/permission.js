export function roleSetOf(user) {
  const roles = Array.isArray(user?.roles) ? user.roles : []
  const set = new Set(roles.map((r) => String(r || '').trim().toLowerCase()).filter(Boolean))
  if (set.has('superadmin')) set.add('admin')
  return set
}

export function hasRole(user, role) {
  const want = String(role || '').trim().toLowerCase()
  if (!want) return false
  return roleSetOf(user).has(want)
}

export function hasAnyRole(user, roles = []) {
  const set = roleSetOf(user)
  return roles.some((r) => set.has(String(r || '').trim().toLowerCase()))
}

export function requireRolesOrJson(req, res, options = {}) {
  const roles = Array.isArray(options.roles) ? options.roles : []
  const actual = [...roleSetOf(req.user)]
  const ok = roles.length === 0 || hasAnyRole(req.user, roles)
  if (ok) return true
  const { jsonError } = options
  const payload = {
    requiredRoles: roles,
    actualRoles: actual,
    ...(options.requiredCapability ? { requiredCapability: options.requiredCapability } : {}),
  }
  if (typeof jsonError === 'function') {
    jsonError(res, 403, options.message || '权限不足', 'forbidden', payload)
  } else {
    res.status(403).json({
      ok: false,
      success: false,
      message: options.message || '权限不足',
      code: 'forbidden',
      error: 'forbidden',
      details: payload,
    })
  }
  return false
}
