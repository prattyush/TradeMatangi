import type { AccountRequest } from './DesktopSettingsModal'

export function accountSettingsRequest(
  baseUrl: string,
  token: string,
  nativeRequest?: AccountRequest
): AccountRequest {
  return async <T>(
    path: string,
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    body: Record<string, unknown> = {}
  ): Promise<T> => {
    if (
      path.startsWith('/') ||
      path.split('/').some(segment => segment === '..' || segment === '.') ||
      path.includes('?') ||
      path.includes('#')
    )
      throw new Error('Invalid settings path')
    if (nativeRequest) return nativeRequest<T>(path, method, body)
    const response = await fetch(
      `${baseUrl.replace(/\/$/, '')}/api/desktop/v1/settings/${path}`,
      {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body:
          method === 'GET' || method === 'DELETE'
            ? undefined
            : JSON.stringify(body)
      }
    )
    if (!response.ok)
      throw new Error(
        `Settings request failed (${response.status}): ${await response.text()}`
      )
    return (response.status === 204 ? null : await response.json()) as T
  }
}
