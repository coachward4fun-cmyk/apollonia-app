import React from 'react';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import DashboardScreen from '../screens/DashboardScreen';
import RemindersScreen from '../screens/RemindersScreen';

const Stack = createNativeStackNavigator();

export default function DashboardNavigator() {
  return (
    <Stack.Navigator
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: '#f9fafb' },
      }}
    >
      <Stack.Screen name="DashboardHome" component={DashboardScreen} />
      <Stack.Screen name="Reminders" component={RemindersScreen} />
    </Stack.Navigator>
  );
}
