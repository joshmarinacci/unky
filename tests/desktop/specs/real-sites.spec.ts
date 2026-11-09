import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { inspect, invoke, results } from '../wdio.conf.js';

type PageProbe = { url: string; title: string; readyState: string; text: string; resourceUrls: string[] };
type VisitResult = { page: PageProbe; loadError?: string };

const sites = [
  { name: 'CNN', url: 'https://www.cnn.com/' },
  { name: 'Forbes', url: 'https://www.forbes.com/' },
  { name: 'Wookieepedia (Star Wars)', url: 'https://starwars.fandom.com/wiki/Wookieepedia' },
  { name: 'Harry Potter Wiki', url: 'https://harrypotter.fandom.com/wiki/Main_Page' },
  { name: 'Marvel Database', url: 'https://marvel.fandom.com/wiki/Marvel_Database' },
  { name: 'DC Comics Database', url: 'https://dc.fandom.com/wiki/DC_Comics_Database' },
  { name: 'Memory Alpha (Star Trek)', url: 'https://memory-alpha.fandom.com/wiki/Portal:Main' },
  { name: 'Doctor Who Wiki', url: 'https://tardis.fandom.com/wiki/Doctor_Who_Wiki' },
  { name: 'Simpsons Wiki', url: 'https://simpsons.fandom.com/wiki/The_Simpsons' },
  { name: 'Pokémon Wiki', url: 'https://pokemon.fandom.com/wiki/Pok%C3%A9mon_Wiki' },
];

const knownTrackerHosts = [
  'doubleclick.net', 'googlesyndication.com', 'googleadservices.com', 'google-analytics.com',
  'googletagmanager.com', 'scorecardresearch.com', 'quantserve.com', 'taboola.com',
  'outbrain.com', 'adnxs.com', 'criteo.com', 'adsrvr.org', 'rubiconproject.com',
  'pubmatic.com', 'casalemedia.com', 'facebook.net', 'hotjar.com', 'segment.com',
  'mixpanel.com', 'amplitude.com', 'clarity.ms', 'bat.bing.com', 'gumgum.com',
  'amazon-adsystem.com', 'audiencesquare.net', 'quantcount.com', 'id5-sync.com',
  'liveintent.com', 'crwdcntrl.net', 'parsely.com', 'openx.net', 'wikia-services.com',
  'fastly-insights.com',
];

const isRealSiteRun = process.env.MY_BROWSER_REAL_SITE_TESTS === '1';
(isRealSiteRun ? it : it.skip)('compares known tracker requests on live publisher and fan-wiki sites with filtering off and on', async () => {
  const tabId = 'tab-1';
  const hostOf = (resource: string) => {
    try { return new URL(resource).hostname.toLowerCase(); } catch { return ''; }
  };
  const isKnownTracker = (host: string) => knownTrackerHosts.some(domain => host === domain || host.endsWith(`.${domain}`));
  let visitNumber = 0;

  async function visit(url: string): Promise<VisitResult> {
    const expectedHost = new URL(url).hostname;
    const visitUrl = new URL(url);
    visitUrl.searchParams.set('_trackerTest', `${Date.now()}-${++visitNumber}`);
    await invoke('navigate', { tabId, url: visitUrl.toString() });
    try {
      await browser.waitUntil(async () => {
        const page = await inspect(tabId) as PageProbe;
        let actualHost = '';
        try { actualHost = new URL(page.url).hostname; } catch {}
        return (actualHost === expectedHost || actualHost.endsWith(`.${expectedHost}`))
          && page.readyState !== 'loading' && page.title.length > 0 && page.text.trim().length > 20;
      }, { timeout: 20000, timeoutMsg: `Live page did not finish loading: ${url}` });
    } catch (error) {
      const page = await inspect(tabId) as PageProbe;
      return { page, loadError: `${String(error)}; observed URL=${page.url}, title=${page.title}, readyState=${page.readyState}` };
    }
    // Let deferred ad and analytics scripts start their resource requests.
    await browser.pause(5000);
    return { page: await inspect(tabId) as PageProbe };
  }

  const report: {
    generatedAt: string;
    evidence: string;
    knownTrackerHosts: string[];
    summary: {
      baselineTrackerHostCount: number;
      filteringEnabledTrackerHostCount: number;
      absentWhenFilteringEnabledCount: number;
      observedAbsencePercent: number;
    } | null;
    sites: Array<{
      name: string;
      url: string;
      title: string;
      baselineLoadError?: string;
      filteringEnabledLoadError?: string;
      filteringDisabled: string[];
      filteringEnabled: string[];
      absentWhenFilteringEnabled: string[];
    }>;
  } = {
    generatedAt: new Date().toISOString(),
    evidence: 'WebKit PerformanceResourceTiming entries observed in the page. A host present with filtering disabled and absent with filtering enabled is a candidate blocked request; this is comparative evidence, not a native per-request block callback.',
    knownTrackerHosts,
    summary: null,
    sites: [],
  };

  try {
    const filters = await invoke('get_filter_settings') as { enabled: boolean };
    assert.equal(filters.enabled, true, 'Expected the disposable desktop profile to start with filtering enabled');

    await invoke('set_filtering_enabled', { enabled: false });
    await browser.pause(1500);
    for (const site of sites) {
      const visitResult = await visit(site.url);
      const { page } = visitResult;
      const observed = visitResult.loadError
        ? []
        : [...new Set(page.resourceUrls.map(hostOf).filter(isKnownTracker))].sort();
      report.sites.push({
        name: site.name,
        url: site.url,
        title: page.title,
        ...(visitResult.loadError ? { baselineLoadError: visitResult.loadError } : {}),
        filteringDisabled: observed,
        filteringEnabled: [],
        absentWhenFilteringEnabled: [],
      });
    }

    await invoke('set_filtering_enabled', { enabled: true });
    await browser.pause(1500);
    for (const [index, site] of sites.entries()) {
      const entry = report.sites[index];
      if (entry.baselineLoadError) continue;
      const visitResult = await visit(site.url);
      const { page } = visitResult;
      if (visitResult.loadError) {
        entry.filteringEnabledLoadError = visitResult.loadError;
        continue;
      }
      entry.filteringEnabled = [...new Set(page.resourceUrls.map(hostOf).filter(isKnownTracker))].sort();
      entry.absentWhenFilteringEnabled = entry.filteringDisabled.filter(host => !entry.filteringEnabled.includes(host));
    }

    const baseline = new Set(report.sites.flatMap(site => site.filteringDisabled.map(host => `${site.name}:${host}`)));
    const enabled = new Set(report.sites.flatMap(site => site.filteringEnabled.map(host => `${site.name}:${host}`)));
    const absent = new Set(report.sites.flatMap(site => site.absentWhenFilteringEnabled.map(host => `${site.name}:${host}`)));
    report.summary = {
      baselineTrackerHostCount: baseline.size,
      filteringEnabledTrackerHostCount: enabled.size,
      absentWhenFilteringEnabledCount: absent.size,
      observedAbsencePercent: baseline.size === 0 ? 0 : Math.round(absent.size / baseline.size * 100),
    };
    writeFileSync(join(results, 'real-site-tracker-results.json'), `${JSON.stringify(report, null, 2)}\n`);
    assert.ok(baseline.size > 0, `No known tracker hosts were observed in the disabled-filter baseline. Inspect ${join(results, 'real-site-tracker-results.json')}`);
    assert.ok(absent.size > 0, `No baseline tracker hosts disappeared with filtering enabled. Inspect ${join(results, 'real-site-tracker-results.json')}`);
  } finally {
    await invoke('set_filtering_enabled', { enabled: true });
    await invoke('navigate', { tabId, url: 'http://127.0.0.1:4179/' });
    writeFileSync(join(results, 'real-site-tracker-results.json'), `${JSON.stringify(report, null, 2)}\n`);
  }
}).timeout(300000);
