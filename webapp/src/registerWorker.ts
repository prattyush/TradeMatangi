/** Register only the app scope, including when installation starts at the website. */
export function registerWebappWorker() {
  if (!('serviceWorker' in navigator)) return
  const register = () => {
    void navigator.serviceWorker.register('/webapp/sw.js', {
      scope: '/webapp/', updateViaCache: 'none',
    }).catch(error => console.warn('Offline page unavailable', error))
  }
  if (document.readyState === 'complete') register()
  else window.addEventListener('load', register, { once: true })
}
