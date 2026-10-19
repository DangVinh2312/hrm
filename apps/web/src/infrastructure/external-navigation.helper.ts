/** Leaves the app for the identity provider. A separate module so tests can observe it. */
export function navigateToExternal(url: string): void {
  window.location.assign(url);
}

/**
 * Full page load of an app path after the server ended every session (link or removal of a
 * sign-in method): nothing of the old session survives in memory, and no route guard can
 * redirect over the notice the target page shows.
 */
export function reloadAt(path: string): void {
  window.location.assign(path);
}
