import React, { createContext, useContext, useEffect, useRef, useState, useCallback, useMemo } from 'react';
import {
  subscribeJobs, subscribeCrews, subscribeCustomers,
  getJobTypes, getEmailConfig, saveCrew,
} from '../services/db';
import { normalizePhone } from '../utils/phoneUtils';

const AppDataContext = createContext({
  jobs: [],
  activeJobs: [],
  crews: [],
  customers: [],
  jobTypes: [],
  emailConfig: null,
  jobsLoading: true,
  crewsLoading: true,
  customersLoading: true,
  refreshCrews: () => {},
  refreshJobTypes: () => {},
  refreshEmailConfig: () => {},
});

export function AppDataProvider({ children }) {
  const [jobs,             setJobs]             = useState([]);
  const [crews,            setCrews]            = useState([]);
  const [customers,        setCustomers]        = useState([]);
  const [jobTypes,         setJobTypes]         = useState([]);
  const [emailConfig,      setEmailConfig]      = useState(null);
  const [jobsLoading,      setJobsLoading]      = useState(true);
  const [crewsLoading,     setCrewsLoading]     = useState(true);
  const [customersLoading, setCustomersLoading] = useState(true);

  // One-time guard so we only run the legacy phone normalization sweep on the
  // first crews snapshot — not on every real-time update.
  const phoneNormalizationDone = useRef(false);

  // ── Real-time subscriptions: jobs and crews live for the entire app session ──
  useEffect(() => {
    const unsubJobs = subscribeJobs((list) => {
      setJobs(list);
      setJobsLoading(false);
    });
    const unsubCrews = subscribeCrews((list) => {
      setCrews(list);
      setCrewsLoading(false);

      if (!phoneNormalizationDone.current && list.length > 0) {
        phoneNormalizationDone.current = true;
        for (const crew of list) {
          const raw = crew.lead?.mobile;
          if (!raw) continue;
          const fixed = normalizePhone(raw);
          if (fixed && fixed !== raw) {
            console.log('[AppData] normalizing crew phone:', crew.name, raw, '→', fixed);
            saveCrew({ ...crew, lead: { ...crew.lead, mobile: fixed } }).catch(() => {});
          }
        }
      }
    });
    const unsubCustomers = subscribeCustomers((list) => {
      setCustomers(list);
      setCustomersLoading(false);
    });
    return () => { unsubJobs(); unsubCrews(); unsubCustomers(); };
  }, []);

  // Derived: active jobs (= jobs not archived because their customer was archived).
  // Computed once here so consumer screens don't each re-filter the same data.
  const activeJobs = useMemo(
    () => jobs.filter((j) => !j.archivedForCustomer),
    [jobs],
  );

  // ── One-shot loaders for data that doesn't have a subscription helper ────────
  const refreshJobTypes = useCallback(() => {
    getJobTypes().then(setJobTypes).catch(() => {});
  }, []);

  const refreshEmailConfig = useCallback(() => {
    getEmailConfig().then((cfg) => { if (cfg) setEmailConfig(cfg); }).catch(() => {});
  }, []);

  // Kept for backwards compatibility — crews is now live via subscription, so
  // this is effectively a no-op. Existing callers that rely on it still work.
  const refreshCrews = useCallback(() => {}, []);

  useEffect(() => {
    refreshJobTypes();
    refreshEmailConfig();
  }, [refreshJobTypes, refreshEmailConfig]);

  // Memoize the context value so its reference is stable across renders when
  // the underlying data hasn't changed. This is important: downstream useMemos
  // in consumer screens depend on the jobs / crews references being stable.
  const value = useMemo(() => ({
    jobs,
    activeJobs,
    crews,
    customers,
    jobTypes,
    emailConfig,
    jobsLoading,
    crewsLoading,
    customersLoading,
    refreshCrews,
    refreshJobTypes,
    refreshEmailConfig,
  }), [
    jobs, activeJobs, crews, customers, jobTypes, emailConfig,
    jobsLoading, crewsLoading, customersLoading,
    refreshCrews, refreshJobTypes, refreshEmailConfig,
  ]);

  return (
    <AppDataContext.Provider value={value}>
      {children}
    </AppDataContext.Provider>
  );
}

export function useAppData() {
  return useContext(AppDataContext);
}
