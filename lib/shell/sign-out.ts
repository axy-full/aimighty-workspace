/**
 * Sign out of Particl, from Workspace's General tab or the Settings menu behind the avatar: the one route
 * (/api/auth/logout), then the sign-in page. Resolves with the sentence to show when it could not be done;
 * on success the page is already leaving.
 */
export async function signOut(fetcher: (url: string, init?: RequestInit) => Promise<Response>): Promise<string | null> {
  try {
    const response = await fetcher("/api/auth/logout", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || "Your account could not be changed. Please try again.");
    window.location.assign("/login");
    return null;
  } catch (cause) {
    return cause instanceof Error && cause.message ? cause.message : "Your account could not be changed. Please try again.";
  }
}
