import React from 'react';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import CrewsScreen from '../screens/CrewsScreen';
import CrewDetailScreen from '../screens/CrewDetailScreen';
import CrewFormScreen from '../screens/CrewFormScreen';
import { colors } from '../theme/colors';

const Stack = createNativeStackNavigator();

export default function CrewsNavigator() {
  return (
    <Stack.Navigator
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: '#f9fafb' },
      }}
    >
      <Stack.Screen name="CrewsList" component={CrewsScreen} />
      <Stack.Screen name="CrewDetail" component={CrewDetailScreen} />
      <Stack.Screen
        name="CrewForm"
        component={CrewFormScreen}
        options={{ presentation: 'modal' }}
      />
    </Stack.Navigator>
  );
}
