import { createNavigationContainerRef } from '@react-navigation/native';

export const navigationRef = createNavigationContainerRef();

export function getCurrentTabName() {
  if (!navigationRef.isReady()) return null;
  const state = navigationRef.getRootState();
  return state?.routes[state.index]?.name ?? null;
}

export function isOnAdminTab() {
  return getCurrentTabName() === 'Admin';
}

export function aiNavigate(name, params) {
  if (navigationRef.isReady()) {
    navigationRef.navigate(name, params);
  }
}
