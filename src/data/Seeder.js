import AsyncStorage from '@react-native-async-storage/async-storage';
import seedData from './seedData.json';

const KEYS = {
  jobs:     'apollonia:jobs_v1',
  crews:    'apollonia:crews_v1',
  expenses: 'apollonia:expenses_v1',
  photos:   'apollonia:photos_v1',
};

// Runs once on app start. Writes seed data only if the jobs key is empty.
export async function seedIfEmpty() {
  try {
    const existing = await AsyncStorage.getItem(KEYS.jobs);
    if (existing !== null) return; // already seeded

    await AsyncStorage.multiSet([
      [KEYS.jobs,     JSON.stringify(seedData.jobs)],
      [KEYS.crews,    JSON.stringify(seedData.crews)],
      [KEYS.expenses, JSON.stringify(seedData.expenses)],
      [KEYS.photos,   JSON.stringify(seedData.photos)],
    ]);

    console.log(
      `[Seeder] Imported ${seedData.jobs.length} jobs, ` +
      `${seedData.crews.length} crews, ` +
      `${seedData.expenses.length} expenses, ` +
      `${seedData.photos.length} photos (${seedData.exportedAt})`
    );
  } catch (err) {
    console.warn('[Seeder] Failed to seed data:', err.message);
  }
}
