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
  const card = () => page.locator('.management-card').filter({has:page.getByRole('heading',{name:'Identity engine',exact:true})});
  return { card, checks:()=>checks, reply:(value:unknown,code=200)=>{result=value;status=code;}, unavailable:()=>{saved=false;} };
}

test('platform management verifies manually with retail credit estimates and safe error results', async ({page},info) => {
  const f = await fixture(page);
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto('/settings#engines');
  const card=f.card(), verify=card.getByRole('button',{name:'Verify connection',exact:true});
  await expect(verify).toBeEnabled();
  await expect(card).toContainText('No training or generation credits are spent.');
  await expect(card.getByRole('textbox')).toHaveCount(0);
  expect(f.checks()).toBe(0);
  f.reply({...verified,providerReferenceId:'private-reference-not-for-ui',credentials:'private-key-not-for-ui'});
  expect((await verify.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await verify.click();
  await expect(card.getByLabel('Identity account verification result')).toContainText('Authentication verified');
  await expect(card).toContainText('720p: 3 credits estimated');
  await expect(card).toContainText('1080p: 6 credits estimated');
  await expect(card).not.toContainText('private-reference-not-for-ui');
  await expect(card).not.toContainText('private-key-not-for-ui');
  await expect(card).not.toContainText('$');
  expect(f.checks()).toBe(1);
  await card.scrollIntoViewIfNeeded();
  await page.screenshot({path:info.outputPath('higgsfield-verification-success.png'),animations:'disabled'});
  f.reply({configured:true,auth:'rejected',readyIdentityAvailable:false,error:'authentication_rejected',estimates:{'720p':{status:'skipped',error:'authentication_rejected'},'1080p':{status:'skipped',error:'authentication_rejected'}}});
  await verify.click();
  await expect(card.getByRole('alert')).toContainText('Authentication rejected');
  await expect(card).not.toContainText('3 credits estimated');
  f.reply({error:'Too many connection checks. Try again later.'},429);
  await verify.click();
  await expect(card.getByRole('alert')).toHaveText('Too many connection checks. Try again later.');
  expect(f.checks()).toBe(3);
  f.unavailable(); await page.reload();
  await expect(verify).toBeDisabled();
  await expect(card).toContainText('Configure the shared engine in the private deployment settings');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
  expect(errors).toEqual([]);
});

test('studio owners see managed availability without account-wide probes or credential controls', async ({page}) => {
  const f=await fixture(page,false);
  await page.goto('/settings#engines');const card=f.card();
  await expect(card).toContainText('Identity engine available');
  await expect(card).toContainText('Generations use your organisation’s Particl credits.');
  await expect(card.getByRole('textbox')).toHaveCount(0);
  await expect(card.getByRole('button',{name:'Verify connection',exact:true})).toHaveCount(0);
  expect(f.checks()).toBe(0);
});
