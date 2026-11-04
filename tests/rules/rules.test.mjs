import { test, before, after, beforeEach } from 'node:test';
import { readFileSync } from 'node:fs';
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc, updateDoc, deleteDoc, serverTimestamp } from 'firebase/firestore';

const ADMIN_EMAIL = 'lolafalobi@gmail.com';
let env;

before(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-tracka',
    firestore: { rules: readFileSync(new URL('../../firestore.rules', import.meta.url), 'utf8') },
  });
});
after(async () => { await env.cleanup(); });
beforeEach(async () => { await env.clearFirestore(); });

const user = (uid, email) => env.authenticatedContext(uid, email ? { email } : {}).firestore();
const seed = (path, data) => env.withSecurityRulesDisabled((c) => setDoc(doc(c.firestore(), path), data));

test('signed-out requests cannot read or write a user doc', async () => {
  const db = env.unauthenticatedContext().firestore();
  await assertFails(getDoc(doc(db, 'users/alice')));
  await assertFails(setDoc(doc(db, 'users/alice'), { a: 1 }));
});

test('owner can read and merge-write normal fields on their own doc', async () => {
  const db = user('alice');
  await assertSucceeds(setDoc(doc(db, 'users/alice'), { displayName: 'A', createdAt: serverTimestamp() }, { merge: true }));
  await assertSucceeds(setDoc(doc(db, 'users/alice'), { trackerState: { x: 1 }, themeMode: 'dark' }, { merge: true }));
  await assertSucceeds(getDoc(doc(db, 'users/alice')));
});

test('owner can still submit a premium receipt request', async () => {
  const db = user('alice');
  await assertSucceeds(setDoc(doc(db, 'users/alice'), { premiumRequest: { status: 'pending', product: 'premium', receiptUrl: 'u' } }, { merge: true }));
});

test("a user cannot read or write someone else's doc", async () => {
  await seed('users/bob', { displayName: 'B' });
  const db = user('alice');
  await assertFails(getDoc(doc(db, 'users/bob')));
  await assertFails(setDoc(doc(db, 'users/bob'), { x: 1 }, { merge: true }));
});

for (const field of ['entitlements', 'billing', 'admin']) {
  test(`owner cannot create their doc with ${field}`, async () => {
    await assertFails(setDoc(doc(user('alice'), 'users/alice'), { [field]: { premium: true } }));
  });
  test(`owner cannot self-grant ${field} via merge on an existing doc`, async () => {
    await seed('users/alice', { displayName: 'A' });
    await assertFails(setDoc(doc(user('alice'), 'users/alice'), { [field]: { premium: true } }, { merge: true }));
    await assertFails(updateDoc(doc(user('alice'), 'users/alice'), { [field]: { premium: true } }));
  });
}

test('owner cannot tamper with a nested entitlements field or delete it via update', async () => {
  await seed('users/alice', { entitlements: { premium: false } });
  const db = user('alice');
  await assertFails(updateDoc(doc(db, 'users/alice'), { 'entitlements.premium': true }));
});

test('owner can update other fields when a server-written entitlements/billing already exists', async () => {
  await seed('users/alice', { entitlements: { premium: true }, billing: { plan: 'monthly' } });
  await assertSucceeds(setDoc(doc(user('alice'), 'users/alice'), { streakCount: 3 }, { merge: true }));
});

test('owner can delete their own doc (account erase flow)', async () => {
  await seed('users/alice', { displayName: 'A' });
  await assertSucceeds(deleteDoc(doc(user('alice'), 'users/alice')));
});

test('admin account can approve Premium on any user doc', async () => {
  await seed('users/bob', { displayName: 'B', premiumRequest: { status: 'pending' } });
  const admin = user('adminuid', ADMIN_EMAIL);
  await assertSucceeds(setDoc(doc(admin, 'users/bob'), { entitlements: { premium: true } }, { merge: true }));
});

test('a different email cannot act as admin', async () => {
  await seed('users/bob', { displayName: 'B' });
  await assertFails(setDoc(doc(user('mallory', 'mallory@example.com'), 'users/bob'), { entitlements: { premium: true } }, { merge: true }));
});

test('featureFlags: signed-in users read, only admin writes, signed-out denied', async () => {
  await seed('featureFlags/global', { newThing: false });
  await assertSucceeds(getDoc(doc(user('alice'), 'featureFlags/global')));
  await assertFails(getDoc(doc(env.unauthenticatedContext().firestore(), 'featureFlags/global')));
  await assertFails(setDoc(doc(user('alice'), 'featureFlags/global'), { newThing: true }));
  await assertSucceeds(setDoc(doc(user('adminuid', ADMIN_EMAIL), 'featureFlags/global'), { newThing: true }));
});

test('every other collection is denied by default', async () => {
  await assertFails(setDoc(doc(user('alice'), 'misc/x'), { a: 1 }));
  await assertFails(getDoc(doc(user('alice'), 'misc/x')));
});

test('errorReports: a signed-in user can only create their own report', async () => {
  const db = user('alice');
  await assertSucceeds(setDoc(doc(db, 'errorReports/r1'), { uid: 'alice', message: 'boom' }));
  await assertFails(setDoc(doc(db, 'errorReports/r2'), { uid: 'bob', message: 'boom' }));
});

test('errorReports: the reporting user cannot read, update, or delete it back', async () => {
  await seed('errorReports/r1', { uid: 'alice', message: 'boom', status: 'open' });
  const db = user('alice');
  await assertFails(getDoc(doc(db, 'errorReports/r1')));
  await assertFails(updateDoc(doc(db, 'errorReports/r1'), { status: 'resolved' }));
  await assertFails(deleteDoc(doc(db, 'errorReports/r1')));
});

test('errorReports: only admin can read, update, or delete', async () => {
  await seed('errorReports/r1', { uid: 'alice', message: 'boom', status: 'open' });
  const admin = user('adminuid', ADMIN_EMAIL);
  await assertSucceeds(getDoc(doc(admin, 'errorReports/r1')));
  await assertSucceeds(updateDoc(doc(admin, 'errorReports/r1'), { status: 'resolved' }));
  await assertSucceeds(deleteDoc(doc(admin, 'errorReports/r1')));
  const mallory = user('mallory', 'mallory@example.com');
  await assertFails(getDoc(doc(mallory, 'errorReports/r1')));
});

test('adminActions: only admin can read or create, signed-out denied', async () => {
  const alice = user('alice');
  await assertFails(setDoc(doc(alice, 'adminActions/a1'), { action: 'clear-devices' }));
  await assertFails(getDoc(doc(alice, 'adminActions/a1')));
  const admin = user('adminuid', ADMIN_EMAIL);
  await assertSucceeds(setDoc(doc(admin, 'adminActions/a1'), { action: 'clear-devices', targetUid: 'alice' }));
  await assertSucceeds(getDoc(doc(admin, 'adminActions/a1')));
  await assertFails(getDoc(doc(env.unauthenticatedContext().firestore(), 'adminActions/a1')));
});
