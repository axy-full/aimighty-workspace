import { test, expect, type Page } from '@playwright/test';
import { signInLocally } from './helpers/workbenchLocal';
import { password, signupInvite } from './helpers/identityAdmin';

const verified = {
  configured: true, auth: 'verified', readyIdentityAvailable: true, error: null,
  estimates: { '720p': { status: 'quoted', credits: 3 }, '1080p': { status: 'quoted', credits: 6 } },
};
async function fixture(page: Page, superAdmin = true) {
  await signInLocally(page.request);
  if (superAdmin) {
    const email = 'platform-owner@example.test';
    let login = await page.request.post('/api/auth/login', { data: { email, password } });
    if (!login.ok()) {
      const code = await signupInvite(email);
      const signup = await page.request.post('/api/auth/signup', { data: { code, name: 'Platform owner', email, workspace: 'Engine verification', password, accept: true } });
      if (!signup.ok()) {
        // Another browser worker may have just created this shared local owner.
        login = await page.request.post('/api/auth/login', { data: { email, password } });
        expect(login.ok(), await login.text()).toBe(true);
      }
    }
  }
  const me = await page.request.get('/api/me').then(response => response.json());
  expect(me.superAdmin).toBe(superAdmin);
  const scope = `particl-active-${me.workspace.id}-${me.id}`;
  let checks = 0, saved = true, result: unknown = verified, status = 200;
  await page.route('**/api/workspaces/keys', route => {
    expect(route.request().method()).toBe('GET');
    return route.fulfill({ json:{ mode:'platform', managed:true, keyring:true, keys:[{name:'higgsfield',set:saved,masked:null}] } });
  });
  await page.route('**/api/workspaces/keys/higgsfield/verify', route => {
    expect(route.request().method()).toBe('POST');
    expect(route.request().headers()['x-workbench-scope']).toBe(scope);
    expect(route.request().postDataJSON()).toEqual({});
    checks++;
    return route.fulfill({ status, json:result });
  });
  await page.route(/\/api\/(generate|soul\/identities|identities\/.+\/train)$/, route => {
    if (route.request().method() === 'POST') throw new Error('Verification must not start training or generation.');
    return route.fallback();
  });
  return { scope, checks:()=>checks, reply:(value:unknown,code=200)=>{result=value;status=code;}, unavailable:()=>{saved=false;} };
}


/*
 * Release 1: the old Settings page and its "Identity engine" card (components/management/HiggsfieldConnection.tsx, drawn by no page
 * since the shell replaced /settings) are gone from every screen, so what stays here is what the route and the new Settings
 * (Advanced > Models > Engines) hold: the platform owner's check is a route only the platform owner can call and it answers in credits,
 * never a vendor's dollar; a studio owner sees availability and no credential control and no probe.
 */
test('the engine check is the platform owner\'s alone and answers in credits, never a vendor dollar', async ({ page }) => {
  const f = await fixture(page, false);
  /* A studio owner (no platform standing) is refused: no account-wide probe is theirs. Nothing is read or sent to the provider. */
  const refused = await page.request.post('/api/workspaces/keys/higgsfield/verify', { headers: { 'X-Workbench-Scope': f.scope }, data: {} });
  expect(refused.status(), await refused.text()).toBe(403);
  expect(JSON.stringify(await refused.json())).not.toMatch(/estimate|credits|usd|\$/i);
});

test('the platform owner\'s check answers with credit estimates only: no dollar field, no provider reference, no credential', async ({ page }, info) => {
  test.skip(info.project.name !== 'workbench-1440x900', 'the route allows 5 checks per 5 minutes: one viewport');
  const f = await fixture(page, true);
  const response = await page.request.post('/api/workspaces/keys/higgsfield/verify', { headers: { 'X-Workbench-Scope': f.scope }, data: {} });
  expect(response.status(), await response.text()).toBe(200);
  const body = await response.json();
  const text = JSON.stringify(body);
  expect(Object.keys(body.estimates).sort()).toEqual(['1080p', '720p']);
  for (const estimate of Object.values(body.estimates) as Record<string, unknown>[]) expect(estimate).not.toHaveProperty('usd');
  expect(text).not.toMatch(/"usd"|\$|api[_-]?key|secret|token|reference/i);
});

test.fixme('platform management verifies manually from a Verify connection button, with credit estimates and safe error results (owner question: the card has no page in Release 1)', async () => {
  /* Was: Identity engine card on /settings#engines (Verify connection, "No training or generation credits are spent.", 720p/1080p
     "N credits estimated", the rejected and rate-limited results, a disabled button with the key unset). The route stays and is
     covered above and in tests/unit/higgsfieldVerification.spec.ts; port the button to Settings > Advanced > Models > Engines for the
     platform owner, or retire the route with the identity engine. */
});

test('studio owners see managed availability on Settings > Advanced > Engines, with no account-wide probe and no credential control', async ({ page }) => {
  const f = await fixture(page, false);
  await page.route('**/api/workspaces/keys', route => route.fulfill({ json: { mode: 'platform', managed: true, keyring: true, keys: [{ name: 'ark', label: 'Connected video account', does: 'Video', set: true, masked: null }, { name: 'openai', label: 'Connected language account', does: 'Thinking models', set: false, masked: null }] } }));
  await page.goto('/suites?view=workspace&tab=advanced&open=models');
  const view = page.getByTestId('settings-view');
  await expect(page.getByTestId('settings-engines')).toContainText('1 available');
  await page.getByTestId('settings-engines-show').click();
  await expect(page.getByTestId('settings-engine')).toHaveText([/Connected video account[\s\S]*Available/, /Connected language account[\s\S]*Unavailable/]);
  /* No credential control: no password or key field, no Verify or Save-key button, nothing masked. */
  await expect(view.locator('input[type="password"], input[name*="key" i], input[aria-label*="key" i]')).toHaveCount(0);
  await expect(page.getByTestId('settings-engine').getByRole('button')).toHaveCount(0);
  await expect(page.getByTestId('settings-engine').getByRole('textbox')).toHaveCount(0);
  await expect(view.getByRole('button', { name: /save key|replace key|remove key/i })).toHaveCount(0);
  await expect(view).not.toContainText(/higgsfield|\$/i);
  expect(f.checks()).toBe(0);
});
