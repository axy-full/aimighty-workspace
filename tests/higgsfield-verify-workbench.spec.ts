import { test, expect, type Page } from '@playwright/test';
import { signInLocally } from './helpers/workbenchLocal';

const verified = {
  configured: true, auth: 'verified', readyIdentityAvailable: true, error: null,
  estimates: { '720p': { status: 'quoted', usd: 0.03 }, '1080p': { status: 'quoted', usd: 0.06 } },
};
async function fixture(page: Page, legacy = false) {
  await signInLocally(page.request);
  const me = await page.request.get('/api/me').then(response => response.json());
  const scope = `particl-active-${me.workspace.id}-${me.id}`;
  let mode = legacy ? 'legacy' : 'own', saved = !legacy;
  let checks = 0, saves = 0, result: unknown = verified, status = 200;
  await page.route('**/api/workspaces/keys', async route => {
    const request = route.request();
    if (request.method() === 'PUT') {
      expect(request.headers()['x-workbench-scope']).toBe(scope);
      expect(request.postDataJSON()).toEqual({ name:'higgsfield', value:'replacement-id:replacement-secret' });
      saves++; saved = true;
      return route.fulfill({ json:{ ok:true, name:'higgsfield', masked:'…cret' } });
    }
    expect(request.method()).toBe('GET');
    return route.fulfill({ json:{ mode, keyring:true, keys:[{name:'higgsfield',set:saved,masked:saved?'…1234':null}] } });
  });
  await page.route('**/api/workspaces/keys/higgsfield/verify', route => {
    expect(route.request().method()).toBe('POST');
    expect(route.request().headers()['x-workbench-scope']).toBe(scope);
    expect(route.request().postDataJSON()).toEqual({});
    checks++;
    return route.fulfill({ status, json:result });
  });
  await page.route(/\/api\/(generate|soul\/identities|identities\/.+\/train)$/, route => {
    if (route.request().method() === 'POST') throw new Error('Connection verification must not start training or generation.');
    return route.fallback();
  });
  const card = () => page.locator('.management-card').filter({has:page.getByRole('heading',{name:'Higgsfield · Soul ID',exact:true})});
  return { card, checks:()=>checks, saves:()=>saves, reply:(value:unknown,code=200)=>{result=value;status=code;}, useOwnWithoutKey:()=>{mode='own';saved=false;} };
}

test('Higgsfield verification is manual, scoped and invalidated by credential edits, with safe success and error results', async ({page},info) => {
  test.skip(!['workbench-360x640','workbench-1440x900'].includes(info.project.name),'bounded connection UI coverage');
  const f = await fixture(page);
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto('/settings#engines');
  const card=f.card();
  await expect(card.getByRole('button',{name:'Verify connection',exact:true})).toBeEnabled();
  await expect(card).toContainText('No training or generation credits are spent.');
  expect(f.checks()).toBe(0);
  f.reply({...verified,providerReferenceId:'private-reference-not-for-ui',credentials:'private-key-not-for-ui'});
  await card.getByRole('button',{name:'Verify connection',exact:true}).click();
  await expect(card.getByRole('status')).toContainText('Authentication verified');
  await expect(card).toContainText('720p: $0.03 estimate');
  await expect(card).toContainText('1080p: $0.06 estimate');
  await expect(card).not.toContainText('private-reference-not-for-ui');
  await expect(card).not.toContainText('private-key-not-for-ui');
  expect(f.checks()).toBe(1);
  await card.scrollIntoViewIfNeeded();
  await page.screenshot({path:info.outputPath('higgsfield-verification-success.png'),animations:'disabled'});
  await card.getByRole('textbox',{name:'Higgsfield API key ID',exact:true}).fill('replacement-id');
  await expect(card.getByText('Authentication verified',{exact:true})).toHaveCount(0);
  await expect(card.getByRole('button',{name:'Verify connection',exact:true})).toBeDisabled();
  await card.getByLabel('Higgsfield API key secret',{exact:true}).fill('replacement-secret');
  await card.getByRole('button',{name:'Save Higgsfield connection',exact:true}).click();
  await expect(card.getByRole('textbox',{name:'Higgsfield API key ID',exact:true})).toHaveValue('');
  await expect(card.getByLabel('Higgsfield API key secret',{exact:true})).toHaveValue('');
  expect(f.saves()).toBe(1);expect(f.checks()).toBe(1);
  await expect(card.getByRole('button',{name:'Verify connection',exact:true})).toBeEnabled();
  f.reply({configured:true,auth:'rejected',readyIdentityAvailable:false,error:'authentication_rejected',estimates:{'720p':{status:'skipped',error:'authentication_rejected'},'1080p':{status:'skipped',error:'authentication_rejected'}}});
  await card.getByRole('button',{name:'Verify connection',exact:true}).click();
  await expect(card.getByRole('alert')).toContainText('Authentication rejected');
  await expect(card).not.toContainText('$0.03 estimate');
  f.reply({error:'Too many connection checks. Try again later.'},429);
  await card.getByRole('button',{name:'Verify connection',exact:true}).click();
  await expect(card.getByRole('alert')).toHaveText('Too many connection checks. Try again later.');
  expect(f.checks()).toBe(3);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
  expect(errors).toEqual([]);
});

test('legacy platform connections can be checked without credential fields and explain skipped estimates',async({page},info)=>{
  test.skip(!['workbench-360x640','workbench-1440x900'].includes(info.project.name),'bounded legacy connection UI coverage');
  const f=await fixture(page,true);
  f.reply({...verified,readyIdentityAvailable:false,estimates:{'720p':{status:'skipped',error:'no_ready_identity'},'1080p':{status:'skipped',error:'no_ready_identity'}}});
  await page.goto('/settings#engines');const card=f.card();
  await expect(card).toContainText('This workspace uses the platform’s Higgsfield connection.');
  await expect(card.getByRole('textbox',{name:'Higgsfield API key ID',exact:true})).toHaveCount(0);
  await expect(card.getByRole('button',{name:'Verify connection',exact:true})).toBeEnabled();
  expect(f.checks()).toBe(0);
  await card.getByRole('button',{name:'Verify connection',exact:true}).click();
  await expect(card.getByRole('status')).toContainText('Authentication verified');
  await expect(card).toContainText('720p: Not checked — No ready Soul identity was found in the first results page.');
  await expect(card).toContainText('No training or generation was started.');
  await card.scrollIntoViewIfNeeded();
  await page.screenshot({path:info.outputPath('higgsfield-legacy-verification.png'),animations:'disabled'});
  f.useOwnWithoutKey();await page.reload();
  await expect(card.getByRole('button',{name:'Verify connection',exact:true})).toBeDisabled();
  await expect(card).toContainText('Save your own Higgsfield connection to verify it.');
  expect(f.checks()).toBe(1);
});
