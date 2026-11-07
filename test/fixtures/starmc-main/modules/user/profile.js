const USERNAME_MIN = 3
const USERNAME_MAX = 32
const DISPLAY_NAME_MAX = 64
const AVATAR_MAX = 512
const BIO_MAX = 100

function invalid(field, message) {
  return { ok: false, status: 400, message, code: 'validation_error', details: { field } }
}

function validAvatar(value) {
  return /^https?:\/\//i.test(value) || /^\/(?!\/)/.test(value)
}

export function applyUserProfilePatch(store, user, input = {}, { allowUsername = true } = {}) {
  if (!user || typeof user !== 'object') return { ok: false, status: 404, message: '用户不存在', code: 'not_found' }
  const changes = {}

  if (allowUsername && input.username !== undefined) {
    const username = String(input.username || '').trim()
    if (username.length < USERNAME_MIN || username.length > USERNAME_MAX) {
      return invalid('username', `username 长度需在 ${USERNAME_MIN}-${USERNAME_MAX} 个字符之间`)
    }
    const duplicate = (store?.users || []).find((candidate) =>
      candidate.id !== user.id && String(candidate.username || '').trim().toLowerCase() === username.toLowerCase())
    if (duplicate) return { ok: false, status: 409, message: '该用户名已被占用', code: 'conflict', details: { field: 'username' } }
    user.username = username
    changes.username = username
  }

  if (input.displayName !== undefined) {
    const displayName = String(input.displayName || '').trim()
    if (displayName.length > DISPLAY_NAME_MAX) return invalid('displayName', `displayName 不能超过 ${DISPLAY_NAME_MAX} 个字符`)
    user.displayName = displayName || undefined
    changes.displayName = displayName || undefined
  }

  if (input.avatar !== undefined) {
    const avatar = String(input.avatar || '').trim()
    if (avatar.length > AVATAR_MAX || (avatar && !validAvatar(avatar))) {
      return invalid('avatar', '头像必须是 http(s) URL 或站内绝对路径，且不能超过 512 个字符')
    }
    user.avatar = avatar || undefined
    changes.avatar = avatar || undefined
  }

  if (input.bio !== undefined) {
    const bio = String(input.bio || '').trim()
    if (bio.length > BIO_MAX) return invalid('bio', `个人简介不能超过 ${BIO_MAX} 个字符`)
    user.bio = bio
    changes.bio = bio
  }

  return { ok: true, changes }
}
