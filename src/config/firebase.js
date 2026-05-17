import { initializeApp } from 'firebase/app';
import { initializeAuth, getReactNativePersistence } from 'firebase/auth';
import {
  initializeFirestore, persistentLocalCache,
  persistentSingleTabManager, getFirestore,
} from 'firebase/firestore';
import { getStorage } from 'firebase/storage';
import AsyncStorage from '@react-native-async-storage/async-storage';

const firebaseConfig = {
  apiKey: 'AIzaSyDol3-DAsfDKmX286e6YwM4A_VW5XnblUo',
  authDomain: 'apollonia-construction.firebaseapp.com',
  projectId: 'apollonia-construction',
  storageBucket: 'apollonia-construction.firebasestorage.app',
  messagingSenderId: '504539802720',
  appId: '1:504539802720:web:145b7a2513f885320f6705',
};

const app = initializeApp(firebaseConfig);

export const auth = initializeAuth(app, {
  persistence: getReactNativePersistence(AsyncStorage),
});

let db;
try {
  db = initializeFirestore(app, {
    localCache: persistentLocalCache({ tabManager: persistentSingleTabManager() }),
  });
} catch {
  db = getFirestore(app);
}
export { db };

export const storage = getStorage(app);
