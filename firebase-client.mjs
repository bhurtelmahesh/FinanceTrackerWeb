import { initializeApp } from 'firebase/app';
import {
  browserLocalPersistence,
  getAuth,
  GoogleAuthProvider,
  onAuthStateChanged,
  setPersistence,
  signInWithPopup,
  signOut
} from 'firebase/auth';
import {
  collection,
  doc,
  getDoc,
  getDocs,
  getFirestore,
  writeBatch
} from 'firebase/firestore';

import { cloudCollections, forCloud } from './cloud-fields.mjs';
import { cloudMetaOperation, cloudRecordKey, planCloudChanges } from './cloud-sync-plan.mjs';

const firebaseConfig = {
  projectId: 'bhurtel-finance-tracker',
  appId: '1:933813388738:web:c1ba834dfa2d4116ba025b',
  storageBucket: 'bhurtel-finance-tracker.firebasestorage.app',
  apiKey: 'AIzaSyBWgSU64aAEJPtONBzaZKFtNgfnNdylNFo',
  authDomain: 'bhurtel-finance-tracker.firebaseapp.com',
  messagingSenderId: '933813388738'
};

export { cloudCollections };

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: 'select_account' });

let baseline = new Map();
let writeQueue = Promise.resolve();

function cleanRecord(record) {
  return JSON.parse(JSON.stringify(record));
}

// Records go up carrying only the fields the rules accept, so an import holding
// extra or legacy fields cannot make Firestore reject the batch. Whatever is left
// behind is named once in the console; it stays in this device's copy.
const droppedFields = new Set();

function cloudRecord(collectionName, source) {
  const { record, dropped } = forCloud(collectionName, cleanRecord(source));
  dropped.forEach((name) => {
    const key = `${collectionName}.${name}`;
    if (droppedFields.has(key)) return;
    droppedFields.add(key);
    console.info(`Cloud sync keeps ${key} on this device only.`);
  });
  return record;
}

function recordDocumentId(recordId) {
  return encodeURIComponent(String(recordId));
}

function setBaseline(data) {
  baseline = new Map();
  cloudCollections.forEach((collectionName) => {
    (data[collectionName] || []).forEach((record) => {
      baseline.set(cloudRecordKey(collectionName, record.id), JSON.stringify(cloudRecord(collectionName, record)));
    });
  });
}

function publicUser(user) {
  if (!user) return null;
  return {
    uid: user.uid,
    displayName: user.displayName || '',
    email: user.email || ''
  };
}

export async function initializeAccountSession(callback) {
  await setPersistence(auth, browserLocalPersistence);
  return onAuthStateChanged(auth, (user) => callback(publicUser(user)));
}

export async function signInWithGoogle() {
  const credential = await signInWithPopup(auth, googleProvider);
  return publicUser(credential.user);
}

export function signOutAccount() {
  return signOut(auth);
}

export async function loadCloudState(uid) {
  const metaSnapshot = await getDoc(doc(db, 'users', uid, 'app', 'meta'));
  const snapshots = await Promise.all(cloudCollections.map(async (collectionName) => {
    const result = await getDocs(collection(db, 'users', uid, collectionName));
    return [collectionName, result.docs.map((entry) => entry.data())];
  }));
  const data = Object.fromEntries(snapshots);
  data.meta = metaSnapshot.exists() ? metaSnapshot.data() : {};
  const exists = metaSnapshot.exists() || snapshots.some(([, records]) => records.length > 0);
  setBaseline(data);
  return { exists, data };
}

async function commitCloudState(uid, data) {
  const { operations, nextBaseline } = planCloudChanges(
    cloudCollections, data, baseline, cloudRecord);

  operations.push(cloudMetaOperation(data));

  for (let start = 0; start < operations.length; start += 450) {
    const batch = writeBatch(db);
    operations.slice(start, start + 450).forEach((operation) => {
      const reference = doc(db, 'users', uid, operation.collectionName, recordDocumentId(operation.recordId));
      if (operation.type === 'delete') batch.delete(reference);
      else batch.set(reference, operation.data);
    });
    await batch.commit();
  }
  baseline = nextBaseline;
}

export function saveCloudState(uid, data) {
  const snapshot = { meta: cleanRecord(data.meta || {}) };
  cloudCollections.forEach((collectionName) => {
    snapshot[collectionName] = cleanRecord(data[collectionName] || []);
  });
  writeQueue = writeQueue.catch(() => {}).then(() => commitCloudState(uid, snapshot));
  return writeQueue;
}

export function resetCloudBaseline() {
  baseline = new Map();
}
