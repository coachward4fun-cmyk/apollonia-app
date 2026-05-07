import React, { createContext, useContext, useState, useEffect } from 'react';
import { auth, db } from '../config/firebase';
import { onAuthStateChanged, signOut } from 'firebase/auth';
import { doc, getDoc, setDoc } from 'firebase/firestore';

const ADMIN_EMAIL = 'coachward4fun@gmail.com';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  // undefined = still loading, null = signed out, object = signed in
  const [user, setUser] = useState(undefined);
  const [role, setRole] = useState('field');

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (firebaseUser) => {
      if (firebaseUser) {
        setUser(firebaseUser);
        try {
          const userRef = doc(db, 'users', firebaseUser.uid);
          const snap    = await getDoc(userRef);

          if (snap.exists()) {
            // User doc exists — use stored role, but always keep admin email as admin
            const storedRole = snap.data().role || 'field';
            const resolvedRole = firebaseUser.email === ADMIN_EMAIL ? 'admin' : storedRole;
            if (resolvedRole !== storedRole) {
              await setDoc(userRef, { role: resolvedRole }, { merge: true });
            }
            setRole(resolvedRole);
          } else {
            // First login — assign admin to the known admin email, field to everyone else
            const newRole = firebaseUser.email === ADMIN_EMAIL ? 'admin' : 'field';
            await setDoc(userRef, {
              email:       firebaseUser.email || '',
              displayName: firebaseUser.displayName || '',
              role:        newRole,
            });
            setRole(newRole);
          }
        } catch (err) {
          console.error('[Auth] role fetch error:', err.message);
          // Fall back: still give admin email its rights even if Firestore is unreachable
          setRole(firebaseUser.email === ADMIN_EMAIL ? 'admin' : 'field');
        }
      } else {
        setUser(null);
        setRole('field');
      }
    });
    return unsub;
  }, []);

  const canWrite = (_section) => true;

  const logout = () => signOut(auth);

  return (
    <AuthContext.Provider value={{ user, role, canWrite, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
