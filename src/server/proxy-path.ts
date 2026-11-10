// isInferenceProxyPath reports whether a path must bypass dashboard session routing.
// Case-insensitive: clients spell the version segment /V1 or /v1, and both must
// reach the proxy instead of falling through to the SPA HTML shell.
export function isInferenceProxyPath(pathname: string): boolean {
  const path = pathname.toLowerCase()
  return (
    path === '/infill' ||
    path === '/v1' ||
    path.startsWith('/v1/') ||
    path.startsWith('/audioapi/v1/') ||
    path === '/audiocpp' ||
    path.startsWith('/audiocpp/')
  )
}
