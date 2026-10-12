// seed: its own, disposable ZZ TEST rows; the caller supplies a migrated scratch database.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID, scryptSync } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
const appDir = fileURLToPath(new URL('../', import.meta.url));
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  options: '-c search_path=otoapp',
});
const q = async (text: string, args: unknown[] = []) => (await pool.query(text, args)).rows;
const password = randomBytes(12).toString('hex');
const sessionPepper = randomBytes(24).toString('hex');
const salt = randomBytes(16).toString('hex');
const hash = scryptSync(password, salt, 64).toString('hex') + '.' + salt;
const run = randomBytes(4).toString('hex');
const results: Record<string, boolean> = {};
const failures: Record<string, string> = {};
let origin = '';
let child: ReturnType<typeof spawn> | undefined;
async function call(method: string, path: string, cookie: string, body?: unknown, bearer?: string) {
  const response = await fetch(origin + path, {
    method,
    headers: {
      cookie,
      ...(bearer ? { authorization: 'Bearer ' + bearer } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data: any = null;
  try {
    data = JSON.parse(text);
  } catch {
    /* A 204 has no body. */
  }
  return { status: response.status, data };
}
async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    results[name] = true;
  } catch (error) {
    results[name] = false;
    failures[name] = error instanceof Error ? error.message : String(error);
  }
}
async function proveScopeDefaults(tenant: string, label: string) {
  for (const role of ['admin', 'manager', 'staff']) {
    const id = randomUUID();
    const email = 'zz-legacy-' + role + label + run + '@example.invalid';
    await q('insert into users(id,email,password,full_name,role) values($1,$2,$3,$4,$5)', [
      id,
      email,
      hash,
      'ZZ TEST scope ' + role,
      role,
    ]);
    const signed = await fetch(origin + '/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ identifier: email, password }),
    });
    assert.equal(signed.status, 200);
    const cookie = signed.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; ');
    const before = await call('GET', '/api/user', cookie);
    assert.equal(before.status, 200);
    await q(
      "insert into user_branch_access(tenant_id,user_id,access_scope) values($1,$2,'selected_branches')",
      [tenant, id],
    );
    const after = await call('GET', '/api/user', cookie);
    assert.equal(after.status, 200);
    assert.equal(after.data.hasAllBranchesAccess, before.data.hasAllBranchesAccess);
    assert.deepEqual(after.data.allowedBranchIds, before.data.allowedBranchIds);
    assert.deepEqual(after.data.modules, before.data.modules);
    assert.equal(after.data.tenantId, tenant);
    assert.equal(after.data.hasAllBranchesAccess, role === 'admin');
    assert.deepEqual(after.data.allowedBranchIds, []);
  }
}
try {
  await q(
    "insert into tenants(name,slug) values ('ZZ TEST shared dictionary','default') on conflict(slug) do nothing",
  );
  const def = (await q("select id from tenants where slug='default'"))[0].id;
  await q(
    "insert into branches(tenant_id,name,address) values($1,'ZZ TEST default','ZZ TEST address')",
    [def],
  );
  const groups = [];

  const start = spawn(
    process.execPath,
    [join(appDir, 'node_modules/tsx/dist/cli.mjs'), 'tests/harness/serve-routes.ts'],
    {
      cwd: appDir,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        APP_ENV: 'dev',
        STORAGE_ENV_PREFIX: 'zz-administration',
        OBJECT_STORAGE: 'local',
        DEPLOY_ENV: 'local',
        OTOAPP_LEGACY_LOGIN: 'true',
        OTOAPP_JOBS: 'platform',
        USE_AWS_REKOGNITION: 'false',
        LOG_LEVEL: 'warn',
        SESSION_SECRET: randomBytes(24).toString('hex'),
        SESSION_PEPPER: sessionPepper,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  child = start;
  origin = await new Promise<string>((resolve, reject) => {
    let output = '';
    const timer = setTimeout(
      () =>
        reject(
          new Error(
            'Administration harness start timed out: ' +
              output
                .slice(-3000)
                .replaceAll(password, '[redacted]')
                .replaceAll(hash, '[redacted]')
                .replaceAll(process.env.DATABASE_URL ?? '[absent]', '[database]'),
          ),
        ),
      180000,
    );
    const read = (part: Buffer) => {
      output += part.toString();
      const match = /HARNESS_PORT=(\d+)/.exec(output);
      if (match) {
        clearTimeout(timer);
        resolve('http://127.0.0.1:' + match[1]);
      }
    };
    start.stdout!.on('data', read);
    start.stderr!.on('data', read);
    start.on('exit', () => {
      clearTimeout(timer);
      reject(
        new Error(
          'Administration harness exited before listening: ' +
            output
              .slice(-3000)
              .replaceAll(password, '[redacted]')
              .replaceAll(hash, '[redacted]')
              .replaceAll(process.env.DATABASE_URL ?? '[absent]', '[database]'),
        ),
      );
    });
  });
  await check('userScopeDefaultsSingle', () => proveScopeDefaults(def, 'single'));
  for (const letter of ['A', 'B']) {
    const tenant = (
      await q('insert into tenants(name,slug) values($1,$2) returning id', [
        'ZZ TEST ' + letter,
        'zz-administration-' + letter + run,
      ])
    )[0].id;
    const branch = (
      await q(
        "insert into branches(tenant_id,name,address) values($1,$2,'ZZ TEST address') returning id",
        [tenant, 'ZZ TEST ' + letter],
      )
    )[0].id;
    const email = 'zz-administration-' + letter + run + '@example.invalid';
    const id = randomUUID();
    await q("insert into users(id,email,password,full_name,role) values($1,$2,$3,$4,'admin')", [
      id,
      email,
      hash,
      'ZZ TEST ' + letter,
    ]);
    await q(
      "insert into user_branch_access(tenant_id,user_id,access_scope) values($1,$2,'all_branches')",
      [tenant, id],
    );
    groups.push({ tenant, branch, id, email, cookie: '' });
  }
  const [a, b] = groups;
  for (const group of groups) {
    const r = await fetch(origin + '/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ identifier: group.email, password }),
    });
    assert.equal(r.status, 200);
    group.cookie = r.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; ');
  }
  const person = (
    await q(
      "insert into people(tenant_id,full_name,email,person_type) values($1,$2,$3,'ADVISOR') returning id",
      [a.tenant, 'ZZ TEST person', 'zz-person-' + run + '@example.invalid'],
    )
  )[0].id;
  const policy = (
    await q(
      "insert into access_policies(tenant_id,person_id,access_level,modules,branch_scope) values($1,$2,'STAFF','{}','ALL') returning id",
      [a.tenant, person],
    )
  )[0].id;
  await check('people', async () => {
    assert.equal((await call('GET', '/api/people/' + person, b.cookie)).status, 404);
    assert.equal(
      (await call('PATCH', '/api/people/' + person, b.cookie, { fullName: 'ZZ TEST foreign' }))
        .status,
      404,
    );
    assert.equal((await call('GET', '/api/people/' + person + '/access', b.cookie)).status, 404);
    assert.equal(
      (
        await call('PUT', '/api/people/' + person + '/access', b.cookie, {
          accessLevel: 'ADMIN',
          modules: { core: true, hr: true },
          branchScope: 'ALL',
        })
      ).status,
      404,
    );
    const list = await call('GET', '/api/people', b.cookie);
    assert.equal(list.status, 200);
    assert.ok(!list.data.some((p: any) => p.id === person));
    const created = await call('POST', '/api/people', a.cookie, {
      fullName: 'ZZ TEST no login',
      email: 'zz-no-login-' + run + '@example.invalid',
      personType: 'ADVISOR',
      createLogin: false,
      tenantId: b.tenant,
    });
    assert.equal(created.status, 201);
    assert.equal(created.data.tenantId, a.tenant);
    assert.equal((await call('GET', '/api/people/' + created.data.id, a.cookie)).status, 200);
    assert.equal(
      (
        await call('PATCH', '/api/people/' + created.data.id, a.cookie, {
          fullName: 'ZZ TEST edited',
          tenantId: b.tenant,
        })
      ).status,
      200,
    );
    assert.equal((await call('GET', '/api/people/' + created.data.id, b.cookie)).status, 404);
    assert.equal(
      (
        await q('select count(*)::int n from access_policies where person_id=$1', [created.data.id])
      )[0].n,
      0,
    );
    await q('update access_policies set tenant_id=$1 where id=$2', [b.tenant, policy]);
    assert.equal((await call('GET', '/api/people/' + person, a.cookie)).status, 404);
    assert.equal((await call('GET', '/api/people/' + person, b.cookie)).status, 404);
    await q('update access_policies set tenant_id=$1 where id=$2', [a.tenant, policy]);
  });
  const legacy = (
    await q(
      "insert into people(full_name,email,person_type) values('ZZ TEST unplaced',$1,'ADVISOR') returning id",
      ['zz-unplaced-' + run + '@example.invalid'],
    )
  )[0].id;
  const legacyRead = await call('GET', '/api/people/' + legacy, a.cookie);
  const anonymousRate = await call('GET', '/api/data-admin/auth-rate-limits', a.cookie);
  results.legacyPlacement = legacyRead.status === 200;
  results.anonymousRateAdministration = anonymousRate.status === 200;
  await check('standingArrangements', async () => {
    assert.equal(legacyRead.status, 404);
    assert.equal((await call('GET', '/api/people/' + legacy, b.cookie)).status, 404);
    assert.equal(anonymousRate.status, 503);
    assert.match(anonymousRate.data.error, /park-group ownership link/);
  });
  await check('permissions', async () => {
    for (const method of ['GET', 'PUT', 'DELETE'])
      assert.equal(
        (
          await call(
            method,
            '/api/module-overrides/' + a.id,
            b.cookie,
            method === 'PUT' ? { overrides: [] } : undefined,
          )
        ).status,
        404,
      );
    assert.equal((await call('GET', '/api/permissions/effective/' + a.id, b.cookie)).status, 404);
    const debug = await call('GET', '/api/permissions/debug/all', b.cookie);
    assert.equal(debug.status, 200);
    assert.ok(!debug.data.some((u: any) => u.userId === a.id));
    const bulk = await call('GET', '/api/permissions/bulk', b.cookie);
    assert.equal(bulk.status, 200);
    assert.ok(!bulk.data.some((p: any) => p.personId === person));
    const changed = await call('PUT', '/api/permissions/bulk-update', b.cookie, {
      personIds: [person],
      moduleKey: 'hr',
      enabled: true,
    });
    assert.equal(changed.status, 200);
    assert.equal(changed.data.updated, 0);
  });
  const form = (
    await q(
      "insert into dropoff_forms(tenant_id,name,status) values($1,'ZZ TEST form','draft') returning id",
      [a.tenant],
    )
  )[0].id;
  const version = (
    await q(
      "insert into dropoff_form_versions(form_id,version_number,source_language,schema_json,is_draft) values($1,1,'en','{}',true) returning id",
      [form],
    )
  )[0].id;
  await check('forms', async () => {
    for (const [method, path, body] of [
      ['GET', '/api/dropoff-form/' + form + '/versions', undefined],
      ['GET', '/api/dropoff-form/version/' + version, undefined],
      ['PUT', '/api/dropoff-form/' + form + '/draft', { schemaJson: {}, translations: {} }],
      [
        'PUT',
        '/api/dropoff-form/translation',
        { versionId: version, lang: 'en', key: 'zz', value: 'ZZ TEST' },
      ],
      ['POST', '/api/dropoff-form/' + form + '/publish', {}],
    ] as const)
      assert.equal((await call(method, path, b.cookie, body)).status, 404, path);
    assert.equal(
      (await call('GET', '/api/dropoff-form/' + form + '/versions', a.cookie)).status,
      200,
    );
    assert.equal(
      (
        await call('PUT', '/api/dropoff-form/translation', a.cookie, {
          versionId: version,
          lang: 'en',
          key: 'zz',
          value: 'ZZ TEST',
        })
      ).status,
      200,
    );
    assert.equal(
      (await q('select count(*)::int n from i18n_translations where version_id=$1', [version]))[0]
        .n,
      1,
    );
  });
  await check('vouchers', async () => {
    for (const [method, path] of [
      ['POST', '/api/studio/voucher-templates'],
      ['PATCH', '/api/studio/voucher-templates/zz'],
      ['DELETE', '/api/studio/voucher-templates/zz'],
      ['POST', '/api/hr/employees/zz/vouchers'],
      ['POST', '/api/hr/vouchers/bulk-assign'],
      ['DELETE', '/api/hr/vouchers/zz'],
      ['POST', '/api/core/vouchers/redeem'],
    ]) {
      const r = await call(method, path, a.cookie, {});
      assert.equal(r.status, 409);
      assert.equal(r.data.message, 'Vouchers have moved to the Console');
    }
    assert.equal((await call('GET', '/api/studio/voucher-templates', a.cookie)).status, 200);
  });
  await check('userScopeDefaults', () => proveScopeDefaults(a.tenant, 'multi'));
  await check('dataAdmin', async () => {
    const models = await call('GET', '/api/data-admin/models', a.cookie);
    assert.equal(models.status, 200);
    for (const m of models.data) {
      const r = await call('GET', '/api/data-admin/' + m.slug, a.cookie);
      assert.equal(r.status, m.unavailableReason ? 503 : 200, m.slug + ' ' + r.status);
    }
    for (const method of ['GET', 'PUT', 'DELETE'])
      assert.equal(
        (
          await call(
            method,
            '/api/data-admin/branches/' + a.branch,
            b.cookie,
            method === 'PUT' ? { name: 'ZZ TEST foreign' } : undefined,
          )
        ).status,
        404,
      );
    const branches = await call('GET', '/api/data-admin/branches', b.cookie);
    assert.ok(!branches.data.rows.some((row: any) => row.id === a.branch));
    const create = await call('POST', '/api/data-admin/departments', b.cookie, {
      name: 'ZZ TEST created',
    });
    assert.equal(create.status, 201);
    assert.equal(create.data.tenantId, b.tenant);
    assert.equal(
      (
        await call('POST', '/api/data-admin/department-branch-assignments', b.cookie, {
          departmentId: create.data.id,
          branchId: a.branch,
        })
      ).status,
      404,
    );
    const options = await call('GET', '/api/data-admin/branches/options', b.cookie);
    assert.ok(!options.data.some((row: any) => row.id === a.branch));
    assert.deepEqual(
      (await call('GET', '/api/data-admin/users/options?labelField=password', a.cookie)).data,
      [],
    );
    assert.equal(
      (
        await call('PUT', '/api/data-admin/departments/' + create.data.id, b.cookie, {
          tenantId: a.tenant,
        })
      ).status,
      404,
    );
    assert.equal((await call('GET', '/api/data-admin/persons/' + person, b.cookie)).status, 404);
    const newUser = await call('POST', '/api/data-admin/users', a.cookie, {
      fullName: 'ZZ TEST new login',
      email: 'zz-admin-created-' + run + '@example.invalid',
      password,
      role: 'staff',
    });
    assert.equal(newUser.status, 201);
    assert.ok(!('password' in newUser.data));
    assert.equal(
      (await call('GET', '/api/data-admin/users/' + newUser.data.id, a.cookie)).status,
      200,
    );
    assert.equal(
      (await call('GET', '/api/data-admin/users/' + newUser.data.id, b.cookie)).status,
      404,
    );
  });
  await check('softLinks', async () => {
    assert.equal(
      (
        await call('PUT', '/api/data-admin/access-policies/' + policy, a.cookie, {
          coreUserId: b.id,
        })
      ).status,
      404,
    );
    for (const branchIds of [b.branch, { branchId: b.branch }, [1], [b.branch]])
      assert.equal(
        (await call('PUT', '/api/data-admin/access-policies/' + policy, a.cookie, { branchIds }))
          .status,
        Array.isArray(branchIds) && typeof branchIds[0] === 'string' ? 404 : 400,
      );
    assert.equal(
      (
        await call('PUT', '/api/data-admin/access-policies/' + policy, a.cookie, {
          branchIds: [a.branch],
        })
      ).status,
      200,
    );
    await q('update access_policies set core_user_id=$1 where id=$2', [b.id, policy]);
    assert.equal(
      (
        await call('PUT', '/api/data-admin/access-policies/' + policy, a.cookie, {
          accessLevel: 'ADMIN',
        })
      ).status,
      404,
    );
    assert.equal(
      (
        await call('PUT', '/api/people/' + person + '/access', a.cookie, {
          accessLevel: 'ADMIN',
          modules: { core: true, hr: true },
          branchScope: 'ALL',
        })
      ).status,
      404,
    );
    assert.equal(
      (
        await call('PUT', '/api/data-admin/access-policies/' + policy, a.cookie, {
          coreUserId: null,
          branchIds: null,
        })
      ).status,
      200,
    );
    assert.equal((await call('GET', '/api/people/' + person, a.cookie)).status, 200);
  });
  await check('privateReferences', async () => {
    assert.equal(
      (
        await call('POST', '/api/data-admin/files', a.cookie, {
          storageKey: 'staging/tenants/' + b.tenant + '/private-object',
          originalFilename: 'ZZ TEST file',
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await call('PUT', '/api/data-admin/branches/' + a.branch, a.cookie, {
          coreBranchId: randomUUID(),
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await call('PUT', '/api/data-admin/users/' + a.id, a.cookie, {
          platformUserId: randomUUID(),
        })
      ).status,
      409,
    );
    const employee = (
      await q(
        "insert into employees(tenant_id,full_name,nickname,email,profile_photo_path) values($1,'ZZ TEST private reference','ZZ TEST',$2,'/uploads/employee-photos/zz-own.png') returning id",
        [a.tenant, 'zz-private-' + run + '@example.invalid'],
      )
    )[0].id;
    assert.equal(
      (
        await call('PUT', '/api/data-admin/employees/' + employee, a.cookie, {
          profilePhotoPath: '/uploads/employee-photos/zz-foreign.png',
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await call('PUT', '/api/data-admin/employees/' + employee, a.cookie, {
          fullName: 'ZZ TEST retained',
          profilePhotoPath: '/uploads/employee-photos/zz-own.png',
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await call('PUT', '/api/data-admin/employees/' + employee, a.cookie, {
          profilePhotoPath: 'https://example.invalid/public-profile.png',
        })
      ).status,
      200,
    );
  });
  await check('presence', async () => {
    const employee = (
      await q(
        "insert into employees(tenant_id,full_name,nickname,email) values($1,'ZZ TEST presence','ZZ TEST','zz-presence-" +
          run +
          "@example.invalid') returning id",
        [a.tenant],
      )
    )[0].id;
    await q(
      'insert into employee_presence(employee_id,tenant_id,is_clocked_in) values($1,$2,false)',
      [employee, a.tenant],
    );
    assert.equal(
      (await call('GET', '/api/data-admin/employee-presences/' + employee, b.cookie)).status,
      404,
    );
    assert.equal(
      (await call('GET', '/api/data-admin/employee-presences/' + employee, a.cookie)).status,
      200,
    );
    assert.equal(
      (
        await call('PUT', '/api/data-admin/employee-presences/' + employee, b.cookie, {
          isClockedIn: true,
        })
      ).status,
      404,
    );
    assert.equal(
      (
        await call('PUT', '/api/data-admin/employee-presences/' + employee, a.cookie, {
          isClockedIn: true,
        })
      ).status,
      200,
    );
    assert.equal(
      (await call('DELETE', '/api/data-admin/employee-presences/' + employee, b.cookie)).status,
      404,
    );
    assert.equal(
      (await q('select is_clocked_in from employee_presence where employee_id=$1', [employee]))[0]
        .is_clocked_in,
      true,
    );
  });
  await check('roles', async () => {
    const shared = (
      await q("insert into roles(tenant_id,name) values($1,'ZZ TEST shared role') returning id", [
        def,
      ])
    )[0].id;
    const foreign = (
      await q("insert into roles(tenant_id,name) values($1,'ZZ TEST private role') returning id", [
        a.tenant,
      ])
    )[0].id;
    await q('insert into role_branch_assignments(role_id,branch_id) values($1,$2)', [
      shared,
      a.branch,
    ]);
    const list = await call('GET', '/api/roles', b.cookie);
    assert.equal(list.status, 200);
    assert.ok(!list.data.some((r: any) => r.id === foreign));
    assert.equal(list.data.find((r: any) => r.id === shared).branches.length, 0);
    assert.equal((await call('GET', '/api/roles/' + foreign, b.cookie)).status, 404);
    const metadata = await call('PATCH', '/api/roles/' + shared, b.cookie, {
      name: 'ZZ TEST shared title',
    });
    const deactivate = await call('POST', '/api/roles/' + shared + '/deactivate', b.cookie, {
      force: true,
    });
    results.sharedRoleMetadataOwnerOnly = metadata.status === 404 && deactivate.status === 404;
    assert.equal(metadata.status, 200);
    assert.equal(deactivate.status, 200);
    assert.equal(
      (await call('POST', '/api/roles', b.cookie, { name: 'ZZ TEST shared created' })).status,
      201,
    );
    assert.equal((await call('GET', '/api/data-admin/roles/' + shared, b.cookie)).status, 200);
    assert.equal(
      (
        await call('PUT', '/api/data-admin/roles/' + shared, b.cookie, {
          name: 'ZZ TEST shared administered',
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await call('PUT', '/api/data-admin/roles/' + foreign, b.cookie, {
          name: 'ZZ TEST private edit',
        })
      ).status,
      404,
    );

    assert.equal(
      (await call('PATCH', '/api/roles/' + shared, b.cookie, { branchIds: [b.branch] })).status,
      200,
    );
    assert.equal(
      (
        await q(
          'select count(*)::int n from role_branch_assignments where role_id=$1 and branch_id=$2',
          [shared, a.branch],
        )
      )[0].n,
      1,
    );
    assert.equal(
      (await call('PATCH', '/api/roles/' + shared, b.cookie, { branchIds: [a.branch] })).status,
      404,
    );
  });
  await check('camp', async () => {
    const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Bangkok' }).format(new Date());
    const other = (
      await q(
        "insert into branches(tenant_id,name,address) values($1,'ZZ TEST other branch','ZZ TEST address') returning id",
        [b.tenant],
      )
    )[0].id;
    const camp = async (tenant: string, branch: string) => {
      const event = (
        await q(
          "insert into core_events(tenant_id,branch_id,event_type,title,event_date,start_time) values($1,$2,'camp','ZZ TEST camp',$3,'10:00') returning id",
          [tenant, branch, today],
        )
      )[0].id;
      const reg = (
        await q(
          "insert into camp_registrations(tenant_id,event_id,child_full_name,date_of_birth,parent_guardian_name,emergency_contact_number,parent_signature,signature_date) values($1,$2,'ZZ TEST child','2018-01-01','ZZ TEST parent','ZZ TEST contact','ZZ TEST signature',$3) returning id",
          [tenant, event, today],
        )
      )[0].id;
      return { event, reg };
    };
    const own = await camp(b.tenant, b.branch),
      otherCamp = await camp(b.tenant, other),
      foreign = await camp(a.tenant, a.branch);
    const limited = randomUUID(),
      email = 'zz-camp-limited-' + run + '@example.invalid';
    await q(
      "insert into users(id,email,password,full_name,role) values($1,$2,$3,'ZZ TEST limited','manager')",
      [limited, email, hash],
    );
    await q(
      "insert into user_branch_access(tenant_id,user_id,branch_id,access_scope) values($1,$2,$3,'selected_branches')",
      [b.tenant, limited, b.branch],
    );
    const sign = await fetch(origin + '/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ identifier: email, password }),
    });
    assert.equal(sign.status, 200);
    const cookie = sign.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; ');
    const kiosk = async (tenant: string, branch: string) => {
      const token = randomBytes(24).toString('hex');
      const device = (
        await q(
          "insert into kiosk_devices(tenant_id,branch_id,name,kiosk_type) values($1,$2,'ZZ TEST reception','reception') returning id",
          [tenant, branch],
        )
      )[0].id;
      await q(
        "insert into kiosk_sessions(tenant_id,kiosk_device_id,session_token_hash,expires_at) values($1,$2,$3,now()+interval '1 hour')",
        [
          tenant,
          device,
          createHash('sha256')
            .update(token + sessionPepper)
            .digest('hex'),
        ],
      );
      return token;
    };
    const ownKiosk = await kiosk(b.tenant, b.branch),
      foreignKiosk = await kiosk(a.tenant, a.branch);
    const actions = ['check-in', 'check-out', 'undo-check-out', 'undo-check-in'];
    for (const action of actions) {
      const path = '/api/core/camp-checkins/' + own.reg + '/' + action;
      assert.equal((await call('POST', path, a.cookie, {})).status, 404);
      assert.equal(
        (await call('POST', '/api/core/camp-checkins/' + foreign.reg + '/' + action, b.cookie, {}))
          .status,
        404,
      );
      assert.equal(
        (await call('POST', '/api/core/camp-checkins/' + otherCamp.reg + '/' + action, cookie, {}))
          .status,
        403,
      );
      assert.equal((await call('POST', path, '', {}, foreignKiosk)).status, 404);
      assert.equal(
        (
          await call(
            'POST',
            '/api/core/camp-checkins/' + otherCamp.reg + '/' + action,
            '',
            {},
            ownKiosk,
          )
        ).status,
        403,
      );
    }
    assert.equal(
      (
        await call('POST', '/api/core/camp-checkins/' + own.reg + '/check-in', b.cookie, {
          paymentMethod: 'cash',
          dropOffPerson: 'ZZ TEST parent',
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await call('POST', '/api/core/camp-checkins/' + own.reg + '/check-in', cookie, {
          paymentMethod: 'cash',
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await q(
          'select count(*)::int n from camp_attendance where camp_registration_id=$1 and attendance_date=$2',
          [own.reg, today],
        )
      )[0].n,
      1,
    );
    assert.equal(
      (
        await call('PATCH', '/api/core/camp-checkins/' + own.reg + '/attendance', b.cookie, {
          date: today,
          staffNotes: 'ZZ TEST note',
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await call('PATCH', '/api/core/camp-checkins/' + own.reg + '/attendance', a.cookie, {
          date: today,
          staffNotes: 'ZZ TEST foreign',
        })
      ).status,
      404,
    );
    assert.equal(
      (
        await call('PATCH', '/api/core/camp-checkins/' + otherCamp.reg + '/attendance', cookie, {
          date: today,
        })
      ).status,
      403,
    );
    for (const action of ['check-in', 'check-out', 'undo-check-out', 'undo-check-in'])
      assert.equal(
        (await call('POST', '/api/core/camp-checkins/' + own.reg + '/' + action, '', {}, ownKiosk))
          .status,
        200,
      );
    assert.equal(
      (await call('POST', '/api/core/camp-checkins/' + own.reg + '/undo-check-in', b.cookie, {}))
        .status,
      200,
    );
    const [saved] = await q(
      'select tenant_id,event_id,status,checked_in_at,checked_out_at,staff_notes from camp_attendance where camp_registration_id=$1 and attendance_date=$2',
      [own.reg, today],
    );
    assert.equal(saved.tenant_id, b.tenant);
    assert.equal(saved.event_id, own.event);
    assert.equal(saved.status, 'waiting');
    assert.equal(saved.checked_in_at, null);
    assert.equal(saved.checked_out_at, null);
    assert.equal(saved.staff_notes, 'ZZ TEST note');
  });
  console.log('ADMINISTRATION_RESULTS=' + JSON.stringify({ results, failures }));
} finally {
  child?.kill();
  await pool.end();
}
