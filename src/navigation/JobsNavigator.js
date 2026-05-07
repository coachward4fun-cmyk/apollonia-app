import React from 'react';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import JobsScreen from '../screens/JobsScreen';
import JobFormScreen from '../screens/JobFormScreen';

const Stack = createNativeStackNavigator();

export default function JobsNavigator() {
  return (
    <Stack.Navigator
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: '#f9fafb' },
      }}
    >
      <Stack.Screen name="JobsList" component={JobsScreen} />
      <Stack.Screen
        name="JobForm"
        component={JobFormScreen}
        options={{ presentation: 'modal' }}
      />
    </Stack.Navigator>
  );
}
