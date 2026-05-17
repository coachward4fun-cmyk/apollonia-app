import React from 'react';
import { useWindowDimensions, Platform } from 'react-native';
import { NavigationContainer } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { Ionicons } from '@expo/vector-icons';

import DashboardScreen from '../screens/DashboardScreen';
import JobsNavigator from './JobsNavigator';
import InvoiceScreen from '../screens/InvoiceScreen';
import CrewsNavigator from './CrewsNavigator';
import ExpensesScreen from '../screens/ExpensesScreen';
import SettingsNavigator from './SettingsNavigator';
import { colors } from '../theme/colors';
import { navigationRef } from '../utils/navigationRef';

const Tab = createBottomTabNavigator();

const TAB_ICONS = {
  Dashboard: 'home',
  Jobs: 'construct',
  Invoice: 'receipt',
  Crews: 'people',
  Expenses: 'wallet',
  Admin: 'shield-checkmark',
};

function AppTabs() {
  const { width, height } = useWindowDimensions();
  const isLandscape     = width > height;
  const isPad           = Platform.OS === 'ios' && Platform.isPad;
  const phoneLandscape  = isLandscape && !isPad;

  return (
    <Tab.Navigator
      screenOptions={({ route }) => ({
        headerShown: false,
        tabBarIcon: ({ focused, color }) => (
          <Ionicons
            name={focused ? TAB_ICONS[route.name] : `${TAB_ICONS[route.name]}-outline`}
            size={isPad ? 26 : phoneLandscape ? 22 : 22}
            color={color}
          />
        ),
        tabBarActiveTintColor:   colors.primary,
        tabBarInactiveTintColor: colors.textMuted,
        tabBarShowLabel: !phoneLandscape,
        tabBarStyle: {
          backgroundColor: colors.white,
          borderTopColor:  colors.border,
          borderTopWidth:  1,
          paddingBottom:   phoneLandscape ? 0 : isPad ? 8 : 4,
          height:          phoneLandscape ? 44 : isPad ? 70 : 60,
        },
        tabBarLabelStyle: {
          fontSize:   isPad ? 12 : 11,
          fontWeight: '600',
        },
        tabBarItemStyle: isPad ? { paddingVertical: 4 } : undefined,
      })}
    >
      <Tab.Screen name="Dashboard" component={DashboardScreen} />
      <Tab.Screen
        name="Jobs"
        component={JobsNavigator}
        listeners={({ navigation }) => ({
          tabPress: (e) => {
            e.preventDefault();
            navigation.navigate('Jobs', {
              screen: 'JobsList',
              params: { clearFilters: Date.now() },
            });
          },
        })}
      />
      <Tab.Screen name="Invoice"    component={InvoiceScreen}   />
      <Tab.Screen name="Crews"      component={CrewsNavigator}  />
      <Tab.Screen name="Expenses"   component={ExpensesScreen}  />
      <Tab.Screen name="Admin"      component={SettingsNavigator} />
    </Tab.Navigator>
  );
}

export default function AppNavigator() {
  return (
    <NavigationContainer ref={navigationRef}>
      <AppTabs />
    </NavigationContainer>
  );
}
