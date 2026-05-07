import React from 'react';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import SettingsScreen from '../screens/SettingsScreen';
import CustomerListScreen from '../screens/CustomerListScreen';
import CustomerEditScreen from '../screens/CustomerEditScreen';
import RevenueYTDScreen from '../screens/RevenueYTDScreen';
import CrewPayYTDScreen from '../screens/CrewPayYTDScreen';
import ActivityLogScreen from '../screens/ActivityLogScreen';

const Stack = createNativeStackNavigator();

export default function SettingsNavigator() {
  return (
    <Stack.Navigator
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: '#f9fafb' },
      }}
    >
      <Stack.Screen name="SettingsList"  component={SettingsScreen} />
      <Stack.Screen name="CustomerList"  component={CustomerListScreen} />
      <Stack.Screen name="CustomerEdit"  component={CustomerEditScreen} />
      <Stack.Screen name="RevenueYTD"    component={RevenueYTDScreen} />
      <Stack.Screen name="CrewPayYTD"    component={CrewPayYTDScreen} />
      <Stack.Screen name="ActivityLog"   component={ActivityLogScreen} />
    </Stack.Navigator>
  );
}
